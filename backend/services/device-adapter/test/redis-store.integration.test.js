import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import mqtt from "mqtt";
import aedes from "aedes";
import { RedisStore } from "../src/store.js";
import { DeviceAdapter } from "../src/adapter.js";
import { Logger } from "../src/log.js";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";

test("RedisStore upsert/list/get roundtrip", async () => {
  const prefix = `test_device_${Date.now()}`;
  const store = new RedisStore({ url: redisUrl, prefix });
  await store.clearTestPrefix();

  const device = { id: "d1", name: "demo", protocol: "zigbee", placement: { room: "lab" } };
  await store.upsert(device);
  const list = await store.list();
  assert.equal(list.length, 1);
  const fetched = await store.get("d1");
  assert.equal(fetched.name, "demo");

  await store.clearTestPrefix();
  await store.close();
});

test("DeviceAdapter writes normalized device to Redis", async () => {
  const prefix = `test_device_${Date.now()}`;
  const store = new RedisStore({ url: redisUrl, prefix });
  await store.clearTestPrefix();

  const broker = aedes();
  const server = net.createServer(broker.handle);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const mqttUrl = `mqtt://127.0.0.1:${port}`;

  const adapter = new DeviceAdapter({
    mode: "mqtt",
    mqttUrl,
    store,
    mockDataDir: "",
    logger: new Logger("error")
  });
  await adapter.start();

  const client = mqtt.connect(mqttUrl);
  await new Promise((resolve) => client.on("connect", resolve));

  const device = {
    friendly_name: "test_plug",
    ieee_address: "0xabc",
    definition: { vendor: "Acme", model: "Plug" }
  };
  client.publish("zigbee2mqtt/bridge/devices", JSON.stringify([device]));

  const state = { state: "ON", power: 5, energy: 0.1 };
  client.publish("zigbee2mqtt/test_plug", JSON.stringify(state));

  const stored = await waitFor(async () => await store.get("test_plug"), 5000);
  assert.ok(stored);
  assert.equal(stored.traits.switch.state, "on");
  assert.equal(stored.traits.switch.power_w, 5);

  client.end(true);
  await adapter.stop();
  await new Promise((resolve) => server.close(resolve));
  broker.close();
  await store.clearTestPrefix();
  await store.close();
});

async function waitFor(fn, timeoutMs = 2000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error("waitFor timeout");
}
