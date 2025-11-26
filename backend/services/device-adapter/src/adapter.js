import fs from "fs/promises";
import path from "path";
import mqtt from "mqtt";
import { normalizeZigbee2Mqtt } from "./normalize.js";

export class DeviceAdapter {
  constructor({ mode, mqttUrl, store, mockDataDir, logger, haBaseUrl, haToken, actionTransport }) {
    this.mode = mode;
    this.mqttUrl = mqttUrl;
    this.store = store;
    this.mockDataDir = mockDataDir;
    this.logger = logger;
    this.client = null;
    this.haBaseUrl = haBaseUrl;
    this.haToken = haToken;
    this.actionTransport = actionTransport || "auto";
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
    if (!this.store) return;
    const device = await this.store.get(action.id);
    if (!device) {
      this.logger.warn("Action ignored, device not found", action.id);
      return;
    }

    const hasZ2M = device.bindings?.zigbee2mqtt?.topic && this.client;
    const preferHa = this.actionTransport === "ha";
    const preferMqtt = this.actionTransport === "mqtt";

    if (!preferHa && hasZ2M) {
      const topic = `${device.bindings.zigbee2mqtt.topic}/set`;
      const payload = buildZ2MSetPayload(action);
      this.logger.info("Publishing action to MQTT", topic, payload);
      this.client.publish(topic, JSON.stringify(payload));
      await this.store.publishActionResult?.({
        id: device.id,
        action: action.action,
        status: "ok",
        transport: "mqtt",
        ts: Date.now()
      });
      return;
    }

    const haEntity = device.bindings?.ha?.entity_id || device.bindings?.ha_entity_id;
    if (!preferMqtt && haEntity && this.haToken) {
      const ok = await callHaService({
        baseUrl: this.haBaseUrl,
        token: this.haToken,
        entityId: haEntity,
        action,
        params: action.params || {},
        logger: this.logger
      });
      await this.store.publishActionResult?.({
        id: device.id,
        action: action.action,
        status: ok ? "ok" : "error",
        transport: "ha",
        ts: Date.now()
      });
      return;
    }

    this.logger.warn("No delivery path for action", action);
    await this.store.publishActionResult?.({
      id: device.id,
      action: action.action,
      status: "error",
      transport: "none",
      ts: Date.now(),
      reason: "no_delivery_path"
    });
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

async function callHaService({ baseUrl, token, entityId, action, params, logger }) {
  const domain = entityId.split(".")[0];
  let service = action.action === "turn_off" ? "turn_off" : "turn_on";
  let payload = { entity_id: entityId };

  if (action.action === "set_brightness") {
    service = "turn_on";
    const pct = typeof params?.brightness === "number" ? params.brightness : undefined;
    payload = { entity_id: entityId, brightness_pct: pct ?? 100 };
  } else if (action.action === "set_cover_position") {
    service = "set_cover_position";
    const pos = typeof params?.position === "number" ? params.position : undefined;
    payload = { entity_id: entityId, position: pos ?? 0 };
  } else if (action.action === "set_temperature") {
    service = "set_temperature";
    const t = typeof params?.temperature === "number" ? params.temperature : params?.target_temperature;
    payload = { entity_id: entityId, temperature: t ?? 22 };
  } else if (action.action === "set_hvac_mode") {
    service = "set_hvac_mode";
    payload = { entity_id: entityId, hvac_mode: params?.mode || "auto" };
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/services/${domain}/${service}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      logger?.warn?.("HA service call failed", res.status, text);
      return false;
    }
    logger?.info?.("HA service called", url);
    return true;
  } catch (err) {
    logger?.error?.("HA service call error", err);
    return false;
  }
}
