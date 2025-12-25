import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SceneStore, SceneStoreError } from "../src/scene-store.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scene-store-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("scene store creates scenes and expands steps", async () => {
  await withTempDir(async (dir) => {
    const store = new SceneStore({ scenesPath: path.join(dir, "scenes.json") });

    await store.create({
      id: "night_base",
      name: "Night Base",
      description: "Base nighttime setup",
      steps: [{ type: "device", deviceId: "lamp", action: "turn_off", params: {} }]
    });

    await store.create({
      id: "sleep",
      name: "Sleep",
      description: "Turn off and close",
      steps: [
        { type: "scene", sceneId: "night_base" },
        {
          type: "device",
          deviceId: "curtain",
          action: "set_cover_position",
          params: { position: 0 },
          wait_for: {
            traitPath: "traits.cover.position",
            operator: "eq",
            value: 0,
            timeoutMs: 20000,
            pollMs: 500,
            on_timeout: "abort"
          }
        }
      ]
    });

    const list = await store.list();
    assert.equal(list.length, 2);

    const expanded = await store.expand("sleep");
    assert.equal(expanded.length, 2);
    assert.equal(expanded[0].deviceId, "lamp");
    assert.equal(expanded[1].deviceId, "curtain");
    assert.ok(expanded[1].wait_for);
  });
});

test("scene store enforces dependents on delete", async () => {
  await withTempDir(async (dir) => {
    const store = new SceneStore({ scenesPath: path.join(dir, "scenes.json") });

    await store.create({
      id: "base",
      name: "Base",
      description: "Base scene",
      steps: [{ type: "device", deviceId: "lamp", action: "turn_off", params: {} }]
    });
    await store.create({
      id: "child",
      name: "Child",
      description: "References base",
      steps: [{ type: "scene", sceneId: "base" }]
    });

    await assert.rejects(
      () => store.delete("base"),
      (err) => err instanceof SceneStoreError && err.code === "scene_has_dependents"
    );

    const cascade = await store.delete("base", { cascade: true });
    assert.deepEqual(new Set(cascade.removed), new Set(["base", "child"]));
  });
});

test("scene store detects cycles", async () => {
  await withTempDir(async (dir) => {
    const store = new SceneStore({ scenesPath: path.join(dir, "scenes.json") });

    await store.create({
      id: "a",
      name: "A",
      description: "A",
      steps: [{ type: "device", deviceId: "lamp", action: "turn_on", params: {} }]
    });

    await assert.rejects(
      () =>
        store.create({
          id: "b",
          name: "B",
          description: "B",
          steps: [
            { type: "scene", sceneId: "a" },
            { type: "scene", sceneId: "b" }
          ]
        }),
      (err) => err instanceof SceneStoreError && err.code === "invalid_scene"
    );
  });
});
