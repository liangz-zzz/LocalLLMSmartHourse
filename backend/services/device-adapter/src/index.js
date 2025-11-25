import { loadConfig } from "./config.js";
import { Logger } from "./log.js";
import { MemoryStore, RedisStore } from "./store.js";
import { DeviceAdapter } from "./adapter.js";
import { ActionsSubscriber } from "./actions-subscriber.js";

async function main() {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  const store =
    config.storage === "redis"
      ? new RedisStore({
          url: config.redisUrl,
          prefix: config.redisKeyPrefix,
          updatesChannel: config.redisUpdatesChannel,
          logger
        })
      : new MemoryStore();

  const adapter = new DeviceAdapter({
    mode: config.mode,
    mqttUrl: config.mqttUrl,
    mockDataDir: config.mockDataDir,
    store,
    logger
  });

  let actionsSubscriber;
  if (config.storage === "redis") {
    actionsSubscriber = new ActionsSubscriber({
      redisUrl: config.redisUrl,
      channel: config.redisActionsChannel,
      logger
    });
    await actionsSubscriber.start((action) => {
      logger.info("Received action (stub only)", action);
      // TODO: map to protocol-specific call (e.g., publish to MQTT)
    });
  }

  await adapter.start();
  logger.info(`Adapter ready (mode=${config.mode})`);

  // keep process alive if mqtt mode
  if (config.mode === "mqtt") {
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
