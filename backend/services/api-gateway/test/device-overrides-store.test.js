import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DeviceOverridesStore } from "../src/device-overrides-store.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "device-overrides-store-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("list ignores reserved top-level keys including virtual", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "devices.config.json");
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          kettle_plug: { name: "烧水壶插座" },
          virtual: {
            enabled: true,
            devices: [{ id: "sim_light", name: "模拟灯", placement: { room: "living_room" }, capabilities: [{ action: "turn_on" }] }]
          },
          voice_control: {
            defaults: { ack_keywords: ["我在"] }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new DeviceOverridesStore({ deviceOverridesPath: filePath });
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "kettle_plug");
  });
});

test("upsert preserves virtual config envelope", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "devices.config.json");
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          virtual: {
            enabled: true,
            defaults: { latency_ms: 100 },
            devices: [{ id: "sim_light", name: "模拟灯", placement: { room: "living_room" }, capabilities: [{ action: "turn_on" }] }]
          },
          devices: [{ id: "kettle_plug", name: "烧水壶插座", placement: { room: "kitchen" } }]
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new DeviceOverridesStore({ deviceOverridesPath: filePath });
    await store.upsert("kettle_plug", { semantics: { aliases: ["水壶"] } });

    const savedRaw = await fs.readFile(filePath, "utf8");
    const saved = JSON.parse(savedRaw);
    assert.equal(saved.virtual.enabled, true);
    assert.equal(saved.virtual.defaults.latency_ms, 100);
    assert.equal(Array.isArray(saved.virtual.devices), true);
    assert.equal(saved.devices.length, 1);
    assert.deepEqual(saved.devices[0].semantics.aliases, ["水壶"]);
  });
});
