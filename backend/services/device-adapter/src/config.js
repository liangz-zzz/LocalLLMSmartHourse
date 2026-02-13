import path from "node:path";

export function loadConfig() {
  const mode = process.env.MODE || "offline"; // offline | mqtt | ha
  const storage = process.env.STORAGE || (mode === "offline" ? "memory" : "redis");
  const configDir = String(process.env.CONFIG_DIR || "").trim();
  const defaultDeviceConfigPath = configDir ? path.join(configDir, "devices.config.json") : "./devices.config.json";
  return {
    mode,
    mqttUrl: process.env.MQTT_URL || "mqtt://localhost:1883",
    mockDataDir: new URL("../mock-data/zigbee2mqtt", import.meta.url),
    deviceConfigPath: process.env.DEVICE_CONFIG_PATH || process.env.DEVICES_CONFIG_PATH || defaultDeviceConfigPath,
    deviceOverridesPollMs: parsePositiveInt(process.env.DEVICE_OVERRIDES_POLL_MS, 2000),
    logLevel: process.env.LOG_LEVEL || "info",
    storage, // memory | redis
    redisUrl: process.env.REDIS_URL || "redis://redis:6379",
    redisKeyPrefix: process.env.REDIS_PREFIX || "device",
    redisUpdatesChannel: process.env.REDIS_UPDATES_CHANNEL || "device:updates",
    redisActionsChannel: process.env.REDIS_ACTIONS_CHANNEL || "device:actions",
    redisActionResultsChannel: process.env.REDIS_ACTION_RESULTS_CHANNEL || "device:action_results",
    haIncludeDomains: parseCsvList(process.env.HA_INCLUDE_DOMAINS, ["switch", "light", "cover", "climate"]),
    haExcludeDomains: parseCsvList(process.env.HA_EXCLUDE_DOMAINS, []),
    haWsEnabled: process.env.HA_WS_ENABLED !== "false",
    haPollIntervalMs: parsePositiveInt(process.env.HA_POLL_INTERVAL_MS, 0),
    dbEnabled: process.env.DB_ENABLED === "true",
    databaseUrl: process.env.DATABASE_URL || "postgres://smarthome:smarthome@db:5432/smarthome",
    haBaseUrl: process.env.HA_BASE_URL || "http://homeassistant:8123",
    haToken: process.env.HA_TOKEN || process.env.HA_ELEVATED_TOKEN,
    actionTransport: process.env.ACTION_TRANSPORT || "auto" // auto | mqtt | ha
  };
}

function parseCsvList(value, fallback) {
  const raw = String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return raw.length ? raw : fallback;
}

function parsePositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}
