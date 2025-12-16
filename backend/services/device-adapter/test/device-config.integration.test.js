import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import mqtt from "mqtt";
import aedes from "aedes";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { DeviceAdapter } from "../src/adapter.js";
import { MemoryStore } from "../src/store.js";
import { Logger } from "../src/log.js";

test("device overrides apply to discovered zigbee2mqtt device", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-adapter-"));
  const configPath = path.join(tmpDir, "devices.config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        devices: [
          {
            id: "kettle_plug",
            name: "烧水壶插座",
            placement: { room: "kitchen", zone: "counter" },
            capabilities: [{ action: "turn_on" }, { action: "turn_off" }],
            semantics: { aliases: ["烧水壶", "水壶"], tags: ["kettle", "plug"] }
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

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
    deviceConfigPath: configPath,
    logger: new Logger("error")
  });
  await adapter.start();

  const client = mqtt.connect(mqttUrl);
  await new Promise((resolve) => client.on("connect", resolve));

  client.publish(
    "zigbee2mqtt/bridge/devices",
    JSON.stringify([
      {
        friendly_name: "kettle_plug",
        ieee_address: "0xa4c1388d484371ba",
        definition: { vendor: "Acme", model: "Plug" }
      }
    ])
  );

  client.publish("zigbee2mqtt/kettle_plug", JSON.stringify({ state: "OFF", linkquality: 100 }));

  const stored = await waitFor(async () => await store.get("kettle_plug"), 5000);
  assert.equal(stored.name, "烧水壶插座");
  assert.equal(stored.placement.room, "kitchen");
  assert.deepEqual(stored.capabilities.map((c) => c.action).sort(), ["turn_off", "turn_on"]);
  assert.ok(stored.semantics?.aliases?.includes("烧水壶"));

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

