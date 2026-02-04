import { loadConfig } from "./config.js";
import { Logger } from "./log.js";
import { MemoryStore, RedisStore } from "./store.js";
import { DeviceAdapter } from "./adapter.js";
import { ActionsSubscriber } from "./actions-subscriber.js";
import { ensureDatabaseUrl, upsertDeviceAndState } from "./db.js";

async function main() {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  const store =
    config.storage === "redis"
      ? new RedisStore({
          url: config.redisUrl,
          prefix: config.redisKeyPrefix,
          updatesChannel: config.redisUpdatesChannel,
          actionResultsChannel: config.redisActionResultsChannel,
          logger
        })
      : new MemoryStore();

  const adapter = new DeviceAdapter({
    mode: config.mode,
    mqttUrl: config.mqttUrl,
    mockDataDir: config.mockDataDir,
    deviceConfigPath: config.deviceConfigPath,
    store,
    logger,
    haBaseUrl: config.haBaseUrl,
    haToken: config.haToken,
    actionTransport: config.actionTransport,
    haIncludeDomains: config.haIncludeDomains,
    haExcludeDomains: config.haExcludeDomains,
    haWsEnabled: config.haWsEnabled,
    haPollIntervalMs: config.haPollIntervalMs
  });

  if (config.dbEnabled) {
    ensureDatabaseUrl(config.databaseUrl);
    const originalUpsert = adapter.store.upsert.bind(adapter.store);
    adapter.store.upsert = async (device) => {
      await originalUpsert(device);
      await upsertDeviceAndState(device);
    };
  }

  let actionsSubscriber;
  if (config.storage === "redis") {
    actionsSubscriber = new ActionsSubscriber({
      redisUrl: config.redisUrl,
      channel: config.redisActionsChannel,
      logger,
      onAction: async (action) => {
        logger.info("Received action", action);
        await adapter.handleAction?.(action);
      }
    });
    await actionsSubscriber.start();
  }

  await adapter.start();
  logger.info(`Adapter ready (mode=${config.mode})`);

  // keep process alive for long-running modes
  if (config.mode === "mqtt" || config.mode === "ha") {
    const shutdown = async () => {
      logger.info("Shutting down adapter");
      await adapter.stop();
      if (actionsSubscriber) await actionsSubscriber.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}

main().catch((err) => {
  console.error("Adapter failed to start", err);
  process.exit(1);
});
