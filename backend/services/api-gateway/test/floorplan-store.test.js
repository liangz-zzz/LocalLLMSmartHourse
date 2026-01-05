import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FloorplanStore, FloorplanStoreError } from "../src/floorplan-store.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "floorplan-store-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildPlan(overrides = {}) {
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
    model: {
      assetId: "asset_model_1",
      url: "/assets/floorplans/floor1.glb",
      mime: "model/gltf-binary",
      size: 3456
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
        deviceId: "humidifier_1",
        x: 0.2,
        y: 0.2,
        height: 1.25,
        rotation: 0,
        scale: 1,
        roomId: "living"
      }
    ],
    ...overrides
  };
}

test("floorplan store creates, updates, and deletes floorplans", async () => {
  await withTempDir(async (dir) => {
    const store = new FloorplanStore({ floorplansPath: path.join(dir, "floorplans.json") });
    const created = await store.create(buildPlan());
    assert.equal(created.id, "floor1");

    const list = await store.list();
    assert.equal(list.length, 1);

    const updated = await store.update("floor1", buildPlan({ name: "二层" }));
    assert.equal(updated.name, "二层");

    const removed = await store.delete("floor1");
    assert.equal(removed.removed, "floor1");

    const empty = await store.list();
    assert.equal(empty.length, 0);
  });
});

test("floorplan store validates rooms and devices", async () => {
  await withTempDir(async (dir) => {
    const store = new FloorplanStore({ floorplansPath: path.join(dir, "floorplans.json") });
    await assert.rejects(
      () =>
        store.create(
          buildPlan({
            rooms: [
              {
                id: "bad",
                name: "bad",
                polygon: [{ x: 0.1, y: 0.2 }]
              }
            ]
          })
        ),
      (err) => err instanceof FloorplanStoreError && err.code === "invalid_floorplan"
    );

    await assert.rejects(
      () =>
        store.create(
          buildPlan({
            devices: [
              {
                deviceId: "humidifier_1",
                x: 1.5,
                y: 0.2
              }
            ]
          })
        ),
      (err) => err instanceof FloorplanStoreError && err.code === "invalid_floorplan"
    );
  });
});

test("floorplan store enforces roomId references", async () => {
  await withTempDir(async (dir) => {
    const store = new FloorplanStore({ floorplansPath: path.join(dir, "floorplans.json") });
    await assert.rejects(
      () =>
        store.create(
          buildPlan({
            devices: [
              {
                deviceId: "humidifier_1",
                x: 0.2,
                y: 0.2,
                roomId: "missing_room"
              }
            ]
          })
        ),
      (err) => err instanceof FloorplanStoreError && err.code === "invalid_floorplan"
    );
  });
});
