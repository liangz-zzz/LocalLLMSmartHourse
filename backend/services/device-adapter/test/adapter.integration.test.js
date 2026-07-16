import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import mqtt from "mqtt";
import aedes from "aedes";
import { DeviceAdapter } from "../src/adapter.js";
import { MemoryStore } from "../src/store.js";
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
  const coordinator = {
    type: "Coordinator",
    friendly_name: "Coordinator",
    ieee_address: "0x00124b0000000000"
  };
  client.publish("zigbee2mqtt/bridge/devices", JSON.stringify([coordinator, device]));

  const state = {
    state: "ON",
    power: 10,
    energy: 1.1,
    linkquality: 90
  };
  client.publish("zigbee2mqtt/living_room_plug", JSON.stringify(state));

  const deviceObj = await waitFor(async () => (await store.get("zigbee:0x00158d00045abcde")) || null, 5000);
  assert.ok(deviceObj, "device should be stored");
  assert.equal(deviceObj.traits.switch.state, "on");
  assert.equal(deviceObj.traits.switch.power_w, 10);
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.get("Coordinator"), undefined);

  client.end(true);
  await adapter.stop();
  await new Promise((resolve) => server.close(resolve));
  broker.close();
});

test("device adapter migrates renamed devices by IEEE address without duplicates", async () => {
  const broker = aedes();
  const server = net.createServer(broker.handle);
  await new Promise((resolve) => server.listen(0, resolve));
  const mqttUrl = `mqtt://127.0.0.1:${server.address().port}`;
  const store = new MemoryStore();

  await store.upsert({
    id: "old_switch_name",
    name: "旧开关名称",
    placement: { room: "living_room", zone: "wall" },
    protocol: "zigbee",
    bindings: {
      zigbee2mqtt: {
        topic: "zigbee2mqtt/old_switch_name",
        friendly_name: "old_switch_name",
        ieee_address: "0x00158D00045ABCDE"
      }
    },
    traits: { switch: { state: "off" } },
    capabilities: [{ action: "turn_on" }],
    semantics: { aliases: ["客厅旧开关"] }
  });

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
  client.publish("zigbee2mqtt/new_switch_name", JSON.stringify({ state: "ON", linkquality: 88 }));
  client.publish(
    "zigbee2mqtt/bridge/devices",
    JSON.stringify([
      {
        friendly_name: "new_switch_name",
        ieee_address: "0x00158d00045abcde",
        definition: { vendor: "Xiaomi", model: "QBKG20LM" }
      }
    ])
  );

  const migrated = await waitFor(async () => {
    const device = await store.get("zigbee:0x00158d00045abcde");
    return device?.traits?.switch?.state === "on" ? device : null;
  }, 5000);
  assert.equal(migrated.name, "new switch name");
  assert.equal(migrated.placement.room, "living_room");
  assert.deepEqual(migrated.semantics.aliases, ["客厅旧开关"]);
  assert.equal(migrated.bindings.zigbee2mqtt.topic, "zigbee2mqtt/new_switch_name");
  assert.equal(await store.get("old_switch_name"), undefined);
  assert.deepEqual((await store.list()).map((device) => device.id), ["zigbee:0x00158d00045abcde"]);

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
