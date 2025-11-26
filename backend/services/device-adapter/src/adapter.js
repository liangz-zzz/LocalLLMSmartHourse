import fs from "fs/promises";
import path from "path";
import mqtt from "mqtt";
import { normalizeZigbee2Mqtt } from "./normalize.js";

export class DeviceAdapter {
  constructor({ mode, mqttUrl, store, mockDataDir, logger }) {
    this.mode = mode;
    this.mqttUrl = mqttUrl;
    this.store = store;
    this.mockDataDir = mockDataDir;
    this.logger = logger;
    this.client = null;
  }

  async start() {
    if (this.mode === "offline") {
      this.logger.info("Starting adapter in offline mode (mock data)");
      return this.loadMockData();
    }
    this.logger.info("Starting adapter in mqtt mode", this.mqttUrl);
    return this.startMqtt();
  }

  async stop() {
    if (this.client) {
      await new Promise((resolve) => this.client.end(false, {}, resolve));
      this.client = null;
    }
  }

  async handleAction(action) {
    // Expected shape: { id, action, params }
    if (!this.client || !this.store) return;
    const device = await this.store.get(action.id);
    if (!device || !device.bindings?.zigbee2mqtt?.topic) {
      this.logger.warn("Action ignored, device not found or missing topic", action.id);
      return;
    }
    const topic = `${device.bindings.zigbee2mqtt.topic}/set`;
    const payload = buildZ2MSetPayload(action);
    this.logger.info("Publishing action to MQTT", topic, payload);
    this.client.publish(topic, JSON.stringify(payload));
  }

  async loadMockData() {
    const devicePath = path.join(new URL(this.mockDataDir).pathname, "device.json");
    const statePath = path.join(new URL(this.mockDataDir).pathname, "state.json");
    const [device, state] = await Promise.all([readJson(devicePath), readJson(statePath)]);
    const normalized = normalizeZigbee2Mqtt({ device, state });
    await this.store.upsert(normalized);
    this.logger.info("Loaded mock device", normalized.id);
  }

  startMqtt() {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect(this.mqttUrl);
      this.client = client;

      client.on("connect", () => {
        this.logger.info("MQTT connected", this.mqttUrl);
        client.subscribe(["zigbee2mqtt/bridge/devices", "zigbee2mqtt/+/availability", "zigbee2mqtt/+"]);
        resolve();
      });

      client.on("error", (err) => {
        this.logger.error("MQTT error", err);
        reject(err);
      });

      client.on("message", async (topic, payload) => {
        try {
          if (topic === "zigbee2mqtt/bridge/devices") {
            const devices = parseJson(payload);
            if (Array.isArray(devices)) {
              this.logger.info("Received device list", devices.length);
              // we only store bindings now; state will come from per-device topics
              for (const dev of devices) {
                const normalized = normalizeZigbee2Mqtt({ device: dev, state: {} });
                await this.store.upsert(normalized);
              }
            }
            return;
          }

          const match = topic.match(/^zigbee2mqtt\/([^/]+)$/);
          if (match) {
            const friendly = match[1];
            const state = parseJson(payload);
            const existing = await this.store.get(friendly);
            const deviceMeta = existing?.bindings?.zigbee2mqtt || { friendly_name: friendly };
            const normalized = normalizeZigbee2Mqtt({ device: deviceMeta, state });
            await this.store.upsert(normalized);
            this.logger.debug("Updated state", friendly);
          }
        } catch (err) {
          this.logger.error("Failed to handle MQTT message", err);
        }
      });
    });
  }
}

function parseJson(buf) {
  try {
    return JSON.parse(buf.toString());
  } catch (_e) {
    return undefined;
  }
}

async function readJson(p) {
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw);
}

function buildZ2MSetPayload(action) {
  if (action.action === "turn_on") return { state: "ON" };
  if (action.action === "turn_off") return { state: "OFF" };
  if (action.action === "set_brightness") {
    const b = action.params?.brightness ?? action.params?.level;
    return { state: "ON", brightness: b ?? 254 };
  }
  return { state: "TOGGLE" };
}
