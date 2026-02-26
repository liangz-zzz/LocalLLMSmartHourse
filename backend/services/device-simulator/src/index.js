import { loadConfig } from "./config.js";
import { Logger } from "./log.js";
import { RedisStore } from "./store.js";
import { DeviceSimulator } from "./simulator.js";
import { ActionsSubscriber } from "./actions-subscriber.js";

async function main() {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  const store = new RedisStore({
    url: config.redisUrl,
    prefix: config.redisKeyPrefix,
    updatesChannel: config.redisUpdatesChannel,
    actionResultsChannel: config.redisActionResultsChannel,
    logger
  });

  const simulator = new DeviceSimulator({
    store,
    logger,
    deviceConfigPath: config.deviceConfigPath,
    enabled: config.enabled,
    defaultLatencyMs: config.defaultLatencyMs,
    defaultFailureRate: config.defaultFailureRate
  });

  const actionsSubscriber = new ActionsSubscriber({
    redisUrl: config.redisUrl,
    channel: config.redisActionsChannel,
    logger,
    onAction: async (action) => {
      const handled = await simulator.handleAction(action);
      if (handled) {
        logger.debug("simulator.action.handled", { id: action?.id, action: action?.action });
      }
    }
  });

  await simulator.start();
  await actionsSubscriber.start();
  logger.info(`Device simulator ready (devices=${simulator.runtimeById.size})`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down device simulator");
    try {
      await actionsSubscriber.stop();
      await simulator.stop();
      await store.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start device simulator", err);
  process.exit(1);
});
