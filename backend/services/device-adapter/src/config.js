export function loadConfig() {
  return {
    mode: process.env.MODE || "offline", // offline | mqtt
    mqttUrl: process.env.MQTT_URL || "mqtt://localhost:1883",
    mockDataDir: new URL("../mock-data/zigbee2mqtt", import.meta.url),
    logLevel: process.env.LOG_LEVEL || "info"
  };
}
