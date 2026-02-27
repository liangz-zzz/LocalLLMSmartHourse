import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import { MockStore } from "../src/store.js";
import { VirtualDevicesStore } from "../src/virtual-devices-store.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "virtual-devices-routes-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("virtual devices routes support config update and preserve envelope", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "devices.config.json");
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          devices: [{ id: "kettle_plug", name: "烧水壶插座" }],
          voice_control: { defaults: { ack_keywords: ["我在"] } },
          virtual: {
            enabled: true,
            defaults: { latency_ms: 50, failure_rate: 0.01 },
            devices: []
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const samplePath = new URL("../src/fixtures/living_room_plug.json", import.meta.url);
    const store = new MockStore(samplePath);
    await store.init();
    const virtualDevicesStore = new VirtualDevicesStore({ deviceConfigPath: filePath });
    const app = buildServer({
      store,
      logger: console,
      config: { mode: "mock", assetsDir: path.join(dir, "assets") },
      virtualDevicesStore
    });

    const listRes = await app.inject({ method: "GET", url: "/virtual-devices/config" });
    assert.equal(listRes.statusCode, 200);
    const listed = listRes.json();
    assert.equal(listed.enabled, true);
    assert.equal(listed.defaults.latency_ms, 50);
    assert.equal(Array.isArray(listed.devices), true);
    assert.equal(listed.devices.length, 0);

    const upsertRes = await app.inject({
      method: "PUT",
      url: "/virtual-devices/sim_light_lr",
      payload: {
        id: "sim_light_lr",
        name: "客厅模拟灯",
        placement: { room: "living_room", zone: "sofa" },
        capabilities: [{ action: "turn_on" }, { action: "turn_off" }],
        traits: { switch: { state: "off" } },
        simulation: { latency_ms: 80, failure_rate: 0.02 }
      }
    });
    assert.equal(upsertRes.statusCode, 200);
    const upserted = upsertRes.json();
    assert.equal(upserted.id, "sim_light_lr");
    assert.equal(upserted.simulation.latency_ms, 80);

    const updateConfigRes = await app.inject({
      method: "PUT",
      url: "/virtual-devices/config",
      payload: {
        enabled: true,
        defaults: { latency_ms: 120, failure_rate: 0.03 }
      }
    });
    assert.equal(updateConfigRes.statusCode, 200);
    const updatedConfig = updateConfigRes.json();
    assert.equal(updatedConfig.defaults.latency_ms, 120);
    assert.equal(updatedConfig.devices.length, 1);

    const deleteRes = await app.inject({ method: "DELETE", url: "/virtual-devices/sim_light_lr" });
    assert.equal(deleteRes.statusCode, 200);
    const deleted = deleteRes.json();
    assert.equal(deleted.removed, "sim_light_lr");

    const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(saved.voice_control.defaults.ack_keywords[0], "我在");
    assert.equal(saved.devices.length, 1);
    assert.equal(saved.virtual.defaults.failure_rate, 0.03);
    assert.equal(Array.isArray(saved.virtual.devices), true);
    assert.equal(saved.virtual.devices.length, 0);

    await app.close();
  });
});
