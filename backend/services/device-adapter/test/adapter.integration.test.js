import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import mqtt from "mqtt";
import aedes from "aedes";
import { DeviceAdapter } from "../src/adapter.js";
import { MemoryStore } from "../src/memory-store.js";
import { Logger } from "../src/log.js";

test("device adapter consumes MQTT messages and stores normalized device", async (t) => {
  const broker = aedes();
  const server = net.createServer(broker.handle);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const mqttUrl = `mqtt://127.0.0.1:${port}`;

  const store = new MemoryStore();
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
    friendly_name: "living_room_plug",
    ieee_address: "0x00158d00045abcde",
    definition: { vendor: "Xiaomi", model: "ZNCZ04LM" }
  };
  client.publish("zigbee2mqtt/bridge/devices", JSON.stringify([device]));

  const state = {
    state: "ON",
    power: 10,
    energy: 1.1,
    linkquality: 90
  };
  client.publish("zigbee2mqtt/living_room_plug", JSON.stringify(state));

  const deviceObj = await waitFor(async () => (await store.get("living_room_plug")) || null, 5000);
  assert.ok(deviceObj, "device should be stored");
  assert.equal(deviceObj.traits.switch.state, "on");
  assert.equal(deviceObj.traits.switch.power_w, 10);

  client.end(true);
  await adapter.stop();
  await new Promise((resolve) => server.close(resolve));
  broker.close();
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
