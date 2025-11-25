import { loadConfig } from "./config.js";
import { Logger } from "./log.js";
import { MemoryStore, RedisStore } from "./store.js";
import { DeviceAdapter } from "./adapter.js";

async function main() {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  const store =
    config.storage === "redis"
      ? new RedisStore({ url: config.redisUrl, prefix: config.redisKeyPrefix, logger })
      : new MemoryStore();

  const adapter = new DeviceAdapter({
    mode: config.mode,
    mqttUrl: config.mqttUrl,
    mockDataDir: config.mockDataDir,
    store,
    logger
  });

  await adapter.start();
  logger.info(`Adapter ready (mode=${config.mode})`);

  // keep process alive if mqtt mode
  if (config.mode === "mqtt") {
    const shutdown = async () => {
      logger.info("Shutting down adapter");
      await adapter.stop();
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
