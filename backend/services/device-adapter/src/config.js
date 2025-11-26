export function loadConfig() {
  const mode = process.env.MODE || "offline"; // offline | mqtt
  const storage = process.env.STORAGE || (mode === "mqtt" ? "redis" : "memory");
  return {
    mode,
    mqttUrl: process.env.MQTT_URL || "mqtt://localhost:1883",
    mockDataDir: new URL("../mock-data/zigbee2mqtt", import.meta.url),
    logLevel: process.env.LOG_LEVEL || "info",
    storage, // memory | redis
    redisUrl: process.env.REDIS_URL || "redis://redis:6379",
    redisKeyPrefix: process.env.REDIS_PREFIX || "device",
    redisUpdatesChannel: process.env.REDIS_UPDATES_CHANNEL || "device:updates",
    redisActionsChannel: process.env.REDIS_ACTIONS_CHANNEL || "device:actions",
    dbEnabled: process.env.DB_ENABLED === "true",
    databaseUrl: process.env.DATABASE_URL || "postgres://smarthome:smarthome@db:5432/smarthome"
  };
}
