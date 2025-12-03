import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import mqtt from "mqtt";
import aedes from "aedes";
import Redis from "ioredis";
import { DeviceAdapter } from "../src/adapter.js";
import { RedisStore } from "../src/store.js";
import { Logger } from "../src/log.js";
import { ActionsSubscriber } from "../src/actions-subscriber.js";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";

test("adapter publishes MQTT set payload on redis action", async () => {
  const broker = aedes();
  const server = net.createServer(broker.handle);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const mqttUrl = `mqtt://127.0.0.1:${port}`;

  const store = new RedisStore({ url: redisUrl, prefix: `act_test_${Date.now()}`, updatesChannel: null });
  await store.clearTestPrefix();

  const adapter = new DeviceAdapter({
    mode: "mqtt",
    mqttUrl,
    store,
    logger: new Logger("error"),
    mockDataDir: "",
    haBaseUrl: "http://homeassistant:8123",
    haToken: "dummy"
  });
  const actionsSubscriber = new ActionsSubscriber({
    redisUrl,
    channel: process.env.REDIS_ACTIONS_CHANNEL || "device:actions",
    logger: new Logger("error"),
    onAction: (action) => adapter.handleAction(action)
  });

  const mqttMessages = [];
  broker.subscribe("zigbee2mqtt/+/set", (packet, cb) => {
    mqttMessages.push({ topic: packet.topic, payload: packet.payload.toString() });
    cb();
  });

  await actionsSubscriber.start();
  await adapter.start();
  await new Promise((r) => setTimeout(r, 200)); // allow Redis subscription to settle

  // seed device metadata
  await store.upsert({
    id: "living_room_plug",
    name: "living room plug",
    placement: { room: "living_room" },
    protocol: "zigbee",
    bindings: { zigbee2mqtt: { topic: "zigbee2mqtt/living_room_plug" } },
    traits: { switch: { state: "off" } },
    capabilities: [{ action: "turn_on" }]
  });

  const pub = new Redis(redisUrl);
  await pub.publish(
    process.env.REDIS_ACTIONS_CHANNEL || "device:actions",
    JSON.stringify({ id: "living_room_plug", action: "turn_on", params: {} })
  );

  const msg = await waitFor(() => mqttMessages[0], 5000);
  assert.ok(msg);
  assert.equal(msg.topic, "zigbee2mqtt/living_room_plug/set");
  assert.equal(JSON.parse(msg.payload).state, "ON");

  await adapter.stop();
  await store.clearTestPrefix();
  await store.close();
  await pub.quit();
  await actionsSubscriber.stop();
  await new Promise((resolve) => server.close(resolve));
  broker.close();
});

test("adapter publishes HA result when MQTT path unavailable", async () => {
  const results = [];
  const store = {
    data: {
      ha_only_device: {
        id: "ha_only_device",
        name: "ha device",
        placement: { room: "lab" },
        protocol: "zigbee",
        bindings: { ha: { entity_id: "switch.test" } },
        traits: {},
        capabilities: [{ action: "turn_on" }]
      }
    },
    async get(id) {
      return this.data[id];
    },
    async publishActionResult(r) {
      results.push(r);
    }
  };

  // stub fetch to simulate HA success
  const origFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, text: async () => "" };
  };

  const adapter = new DeviceAdapter({
    mode: "offline",
    mqttUrl: "mqtt://invalid",
    store,
    logger: new Logger("error"),
    mockDataDir: "",
    haBaseUrl: "http://homeassistant:8123",
    haToken: "dummy",
    actionTransport: "ha"
  });

  await adapter.handleAction({
    id: "ha_only_device",
    action: "turn_on",
    params: {}
  });

  assert.ok(results.length > 0);
  const msg = results[0];
  assert.equal(msg.status, "ok");
  assert.equal(msg.transport, "ha");
  assert.ok(called, "HA fetch should be called");

  globalThis.fetch = origFetch;
});

test("adapter builds correct HA payloads for climate/cover actions", async () => {
  const captured = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, { body }) => {
    captured.push({ url, body: JSON.parse(body) });
    return { ok: true, text: async () => "" };
  };

  const store = {
    data: {
      climate: {
        id: "climate",
        name: "climate",
        placement: { room: "lab" },
        protocol: "zigbee",
        bindings: { ha: { entity_id: "climate.lr_ac" } },
        traits: {},
        capabilities: [{ action: "set_fan_mode" }]
      },
      curtain: {
        id: "curtain",
        name: "curtain",
        placement: { room: "lab" },
        protocol: "zigbee",
        bindings: { ha: { entity_id: "cover.lr_curtain" } },
        traits: {},
        capabilities: [{ action: "set_cover_tilt" }]
      }
    },
    async get(id) {
      return this.data[id];
    },
    async publishActionResult() {}
  };

  const adapter = new DeviceAdapter({
    mode: "offline",
    mqttUrl: "mqtt://invalid",
    store,
    logger: new Logger("error"),
    mockDataDir: "",
    haBaseUrl: "http://homeassistant:8123",
    haToken: "dummy",
    actionTransport: "ha"
  });

  await adapter.handleAction({ id: "climate", action: "set_fan_mode", params: { fan_mode: "low" } });
  await adapter.handleAction({ id: "curtain", action: "set_cover_tilt", params: { tilt: 50 } });

  assert.equal(captured.length, 2);
  assert.ok(captured[0].url.includes("/api/services/climate/set_fan_mode"));
  assert.equal(captured[0].body.fan_mode, "low");
  assert.ok(captured[1].url.includes("/api/services/cover/set_cover_tilt_position"));
  assert.equal(captured[1].body.tilt_position, 50);

  globalThis.fetch = origFetch;
});

async function waitFor(fn, timeoutMs = 2000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timeout");
}
