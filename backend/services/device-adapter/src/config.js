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
    redisKeyPrefix: process.env.REDIS_PREFIX || "device"
  };
}
