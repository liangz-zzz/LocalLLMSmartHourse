import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { MockStore, RedisStore, DbStore } from "./store.js";
import { RedisBus } from "./bus.js";
import { setupWs } from "./ws.js";
import { ActionResultStore } from "./action-store.js";
import { RuleStore } from "./rule-store.js";

function createLogger(level) {
  const levels = ["error", "warn", "info", "debug"];
  const current = levels.includes(level) ? level : "info";
  const should = (lvl) => levels.indexOf(lvl) <= levels.indexOf(current);
  return {
    info: (...args) => should("info") && console.log("[info]", ...args),
    warn: (...args) => should("warn") && console.warn("[warn]", ...args),
    error: (...args) => should("error") && console.error("[error]", ...args),
    debug: (...args) => should("debug") && console.log("[debug]", ...args)
  };
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const samplePath = new URL("./fixtures/living_room_plug.json", import.meta.url);

  let store;
  if (config.mode === "redis") {
    store = new RedisStore({ redisUrl: config.redisUrl, logger, prefix: "device" });
    logger.info("Using Redis store", config.redisUrl);
  } else if (config.mode === "db") {
    store = new DbStore({ databaseUrl: config.databaseUrl, logger });
    logger.info("Using DB store", config.databaseUrl);
  } else {
    store = new MockStore(samplePath);
    await store.init();
    logger.info("Using mock store");
  }

  let bus;
  let actionStore;
  let ruleStore;
  if (config.databaseUrl) {
    if (config.actionResultsPersist) {
      actionStore = new ActionResultStore({ databaseUrl: config.databaseUrl });
    }
    ruleStore = new RuleStore({ databaseUrl: config.databaseUrl });
  }

  if (config.mode === "redis") {
    bus = new RedisBus({
      redisUrl: config.redisUrl,
      updatesChannel: config.redisUpdatesChannel,
      actionsChannel: config.redisActionsChannel,
      actionResultsChannel: config.redisActionResultsChannel,
      logger
    });
    await bus.start();
    if (actionStore) {
      bus.onActionResult(async (result) => {
        try {
          await actionStore.save(result);
        } catch (err) {
          logger.error("Failed to persist action result", err);
        }
      });
    }
  }

  const app = buildServer({ store, logger, config, bus, actionStore, ruleStore });
  await app.listen({ port: config.port, host: "0.0.0.0" });
  if (bus) {
    setupWs({ server: app.server, bus, mode: config.mode, logger, apiKeys: config.apiKeys });
  }
  logger.info(`API Gateway listening on :${config.port} (mode=${config.mode})`);
}

main().catch((err) => {
  console.error("Failed to start API Gateway", err);
  process.exit(1);
});
