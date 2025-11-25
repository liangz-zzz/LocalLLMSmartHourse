import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { MockStore, RedisStore } from "./store.js";

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
    store = new RedisStore(config.redisUrl, logger);
    logger.info("Using Redis store", config.redisUrl);
  } else {
    store = new MockStore(samplePath);
    await store.init();
    logger.info("Using mock store");
  }

  const app = buildServer({ store, logger, config });
  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info(`API Gateway listening on :${config.port} (mode=${config.mode})`);
}

main().catch((err) => {
  console.error("Failed to start API Gateway", err);
  process.exit(1);
});
