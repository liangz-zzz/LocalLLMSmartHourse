import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import { FloorplanStore } from "../src/floorplan-store.js";
import { SceneStore } from "../src/scene-store.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "floorplan-scoped-routes-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildPlan() {
  return {
    id: "floor1",
    name: "一层",
    image: {
      assetId: "asset_img_1",
      url: "/assets/floorplans/floor1.png",
      width: 1000,
      height: 800,
      mime: "image/png",
      size: 1234
    },
    imageScale: {
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.4, y: 0.1 }
      ],
      distanceMeters: 4.5
    },
    rooms: [
      {
        id: "living",
        name: "客厅",
        polygon: [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.1 },
          { x: 0.4, y: 0.4 },
          { x: 0.1, y: 0.4 }
        ]
      }
    ],
    devices: [
      {
        deviceId: "light1",
        x: 0.2,
        y: 0.2,
        roomId: "living"
      }
    ]
  };
}

function buildStore() {
  const items = [
    {
      id: "light1",
      name: "客厅灯",
      protocol: "zigbee",
      placement: { room: "living_room" },
      bindings: { ha: { entity_id: "light.living_room_main" } },
      capabilities: [{ action: "turn_on" }, { action: "turn_off" }],
      traits: { switch: { state: "off" } }
    },
    {
      id: "plug1",
      name: "玄关插座",
      protocol: "zigbee",
      placement: { room: "entryway" },
      bindings: { ha: { entity_id: "switch.entry_plug" } },
      capabilities: [{ action: "turn_on" }, { action: "turn_off" }],
      traits: { switch: { state: "off" } }
    }
  ];
  return {
    async list() {
      return items;
    },
    async get(id) {
      return items.find((item) => item.id === id) || null;
    }
  };
}

test("devices and scenes routes filter by floorplanId", async () => {
  await withTempDir(async (dir) => {
    const floorplanStore = new FloorplanStore({ floorplansPath: path.join(dir, "floorplans.json") });
    const sceneStore = new SceneStore({ scenesPath: path.join(dir, "scenes.json") });
    await floorplanStore.create(buildPlan());
    await sceneStore.create({
      id: "scene_floor1",
      name: "一层欢迎",
      description: "只属于一层",
      scope: { floorplanIds: ["floor1"] },
      steps: [{ type: "device", deviceId: "light1", action: "turn_on", params: {} }]
    });
    await sceneStore.create({
      id: "scene_local_only",
      name: "本地场景",
      description: "没有户型 scope",
      steps: [{ type: "device", deviceId: "plug1", action: "turn_off", params: {} }]
    });

    const app = buildServer({
      store: buildStore(),
      logger: console,
      config: { mode: "mock", assetsDir: path.join(dir, "assets") },
      floorplanStore,
      sceneStore
    });

    const devicesRes = await app.inject({ method: "GET", url: "/devices?floorplanId=floor1" });
    assert.equal(devicesRes.statusCode, 200);
    const devicesJson = devicesRes.json();
    assert.equal(devicesJson.count, 1);
    assert.equal(devicesJson.items[0].id, "light1");

    const scenesRes = await app.inject({ method: "GET", url: "/scenes?floorplanId=floor1" });
    assert.equal(scenesRes.statusCode, 200);
    const scenesJson = scenesRes.json();
    assert.equal(scenesJson.count, 1);
    assert.equal(scenesJson.items[0].id, "scene_floor1");

    await app.close();
  });
});

test("scene routes reject unknown scope floorplans", async () => {
  await withTempDir(async (dir) => {
    const floorplanStore = new FloorplanStore({ floorplansPath: path.join(dir, "floorplans.json") });
    const sceneStore = new SceneStore({ scenesPath: path.join(dir, "scenes.json") });
    await floorplanStore.create(buildPlan());

    const app = buildServer({
      store: buildStore(),
      logger: console,
      config: { mode: "mock", assetsDir: path.join(dir, "assets") },
      floorplanStore,
      sceneStore
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/scenes",
      payload: {
        id: "bad_scope",
        name: "Bad Scope",
        description: "Invalid floorplan id",
        scope: { floorplanIds: ["missing_floorplan"] },
        steps: [{ type: "device", deviceId: "light1", action: "turn_on", params: {} }]
      }
    });

    assert.equal(createRes.statusCode, 400);
    assert.equal(createRes.json().error, "invalid_scene");

    await app.close();
  });
});
