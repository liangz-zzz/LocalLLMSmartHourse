import path from "node:path";

export function loadConfig() {
  const configDir = String(process.env.CONFIG_DIR || "").trim();
  const defaultConfigPath = configDir ? path.join(configDir, "devices.config.json") : "./devices.config.json";
  return {
    enabled: process.env.SIMULATOR_ENABLED !== "false",
    logLevel: process.env.LOG_LEVEL || "info",
    deviceConfigPath:
      process.env.SIM_DEVICE_CONFIG_PATH ||
      process.env.DEVICE_CONFIG_PATH ||
      process.env.DEVICES_CONFIG_PATH ||
      defaultConfigPath,
    redisUrl: process.env.SIM_REDIS_URL || process.env.REDIS_URL || "redis://redis:6379",
    redisKeyPrefix: process.env.SIM_REDIS_PREFIX || process.env.REDIS_PREFIX || "device",
    redisUpdatesChannel: process.env.SIM_UPDATES_CHANNEL || process.env.REDIS_UPDATES_CHANNEL || "device:updates",
    redisActionsChannel: process.env.SIM_ACTIONS_CHANNEL || process.env.REDIS_ACTIONS_CHANNEL || "device:actions",
    redisActionResultsChannel:
      process.env.SIM_ACTION_RESULTS_CHANNEL || process.env.REDIS_ACTION_RESULTS_CHANNEL || "device:action_results",
    defaultLatencyMs: parseNonNegativeInt(process.env.SIM_DEFAULT_LATENCY_MS, 120),
    defaultFailureRate: parseFailureRate(process.env.SIM_DEFAULT_FAILURE_RATE, 0)
  };
}

function parseNonNegativeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parseFailureRate(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
