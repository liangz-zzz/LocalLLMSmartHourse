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

test("list ignores reserved top-level keys including virtual and virtual_models", async () => {
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
          virtual_models: [{ id: "light.dimmer.v1", name: "可调光灯", capabilities: [{ action: "turn_on" }], traits: {} }],
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
          virtual_models: [{ id: "light.dimmer.v1", name: "可调光灯", capabilities: [{ action: "turn_on" }], traits: {} }],
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
    assert.equal(saved.virtual_models[0].id, "light.dimmer.v1");
    assert.equal(saved.devices.length, 1);
    assert.deepEqual(saved.devices[0].semantics.aliases, ["水壶"]);
  });
});

test("upsertVoiceMic preserves virtual/device envelope and updates placement", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "devices.config.json");
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          virtual: {
            enabled: true,
            devices: [{ id: "sim_light", name: "模拟灯" }]
          },
          devices: [{ id: "kettle_plug", name: "烧水壶插座" }],
          voice_control: {
            defaults: { ack_keywords: ["我在"] },
            mics: [
              {
                id: "living-room-respeaker",
                placement: {
                  room: "living_room",
                  coordinates: { x: 0.1, y: 0.2 }
                }
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new DeviceOverridesStore({ deviceOverridesPath: filePath });
    await store.upsertVoiceMic("living-room-respeaker", {
      name: "Living Room ReSpeaker Lite",
      placement: {
        zone: "tv_wall",
        coordinates: { x: 0.55, y: 0.66 }
      }
    });

    const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(saved.virtual.enabled, true);
    assert.equal(saved.devices[0].id, "kettle_plug");
    assert.equal(saved.voice_control.defaults.ack_keywords[0], "我在");
    assert.equal(saved.voice_control.mics[0].name, "Living Room ReSpeaker Lite");
    assert.equal(saved.voice_control.mics[0].placement.room, "living_room");
    assert.equal(saved.voice_control.mics[0].placement.zone, "tv_wall");
    assert.equal(saved.voice_control.mics[0].placement.coordinates.x, 0.55);
    assert.equal(saved.voice_control.mics[0].placement.coordinates.y, 0.66);
  });
});

test("reconcileFloorplanPlacements updates derived placement and preserves manual placement", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "devices.config.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        devices: [
          { id: "manual_sensor", placement: { coordinates: { x: 1, y: 2, z: 0 } } },
          {
            id: "old_light",
            name: "旧灯",
            placement: {
              room: "living_room",
              coordinates: { x: 3, y: 4, z: 1, unit: "m", frame: "floorplan_image", floorplanId: "floor1", source: "floorplan" }
            }
          }
        ],
        voice_control: {
          mics: [
            {
              id: "mic1",
              placement: {
                room: "living_room",
                coordinates: { x: 2, y: 2, z: 1, unit: "m", frame: "floorplan_image", floorplanId: "floor1", source: "floorplan" }
              }
            }
          ]
        }
      }),
      "utf8"
    );
    const store = new DeviceOverridesStore({ deviceOverridesPath: filePath });
    const placements = new Map([
      [
        "new_light",
        {
          floorplanId: "floor2",
          roomId: "bedroom",
          room: "次卧",
          coordinates: { x: 5, y: 6, z: 1.2, unit: "m", frame: "floorplan_image", floorplanId: "floor2", source: "floorplan" }
        }
      ]
    ]);

    await store.reconcileFloorplanPlacements(placements);
    const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.deepEqual(saved.devices.find((item) => item.id === "manual_sensor").placement.coordinates, { x: 1, y: 2, z: 0 });
    assert.equal(saved.devices.find((item) => item.id === "old_light").placement.coordinates, undefined);
    assert.equal(saved.devices.find((item) => item.id === "old_light").placement.room, "living_room");
    assert.equal(saved.devices.find((item) => item.id === "old_light").name, "旧灯");
    assert.equal(saved.devices.find((item) => item.id === "new_light").placement.coordinates.floorplanId, "floor2");
    assert.equal(saved.devices.find((item) => item.id === "new_light").placement.room, "次卧");
    assert.equal(saved.devices.find((item) => item.id === "new_light")._floorplanPlacement.managesRoom, true);
    assert.equal(saved.voice_control.mics[0].placement.coordinates, undefined);
    assert.equal(saved.voice_control.mics[0].placement.room, "living_room");
  });
});

test("floorplan-managed rooms follow moves and renames without overwriting manual room overrides", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "devices.config.json");
    await fs.writeFile(filePath, JSON.stringify({ devices: [] }), "utf8");
    const store = new DeviceOverridesStore({ deviceOverridesPath: filePath });
    const coordinates = { x: 1, y: 2, z: 0, unit: "m", frame: "floorplan_image", floorplanId: "floor1", source: "floorplan" };

    await store.reconcileFloorplanPlacements(
      new Map([["light1", { floorplanId: "floor1", roomId: "living", room: "客厅", coordinates }]])
    );
    let saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(saved.devices[0].placement.room, "客厅");

    await store.reconcileFloorplanPlacements(
      new Map([["light1", { floorplanId: "floor1", roomId: "bedroom", room: "主卧", coordinates }]])
    );
    saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(saved.devices[0].placement.room, "主卧");

    await store.upsert("light1", { placement: { room: "自定义房间" } });
    await store.reconcileFloorplanPlacements(
      new Map([["light1", { floorplanId: "floor1", roomId: "bedroom", room: "重命名后的主卧", coordinates }]])
    );
    saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(saved.devices[0].placement.room, "自定义房间");
    assert.equal(saved.devices[0]._floorplanPlacement.managesRoom, false);

    await store.reconcileFloorplanPlacements(new Map());
    saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(saved.devices[0].placement.room, "自定义房间");
    assert.equal(saved.devices[0].placement.coordinates, undefined);
    assert.equal(saved.devices[0]._floorplanPlacement, undefined);
  });
});
