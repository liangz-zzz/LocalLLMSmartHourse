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

async function waitFor(fn, timeoutMs = 2000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timeout");
}
