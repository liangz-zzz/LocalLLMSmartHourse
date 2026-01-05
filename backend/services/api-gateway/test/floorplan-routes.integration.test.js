import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import { MockStore } from "../src/store.js";
import { FloorplanStore } from "../src/floorplan-store.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "floorplan-routes-"));
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
    rooms: [],
    devices: []
  };
}

test("floorplan routes support CRUD", async () => {
  await withTempDir(async (dir) => {
    const samplePath = new URL("../src/fixtures/living_room_plug.json", import.meta.url);
    const store = new MockStore(samplePath);
    await store.init();
    const floorplanStore = new FloorplanStore({ floorplansPath: path.join(dir, "floorplans.json") });
    const config = { mode: "mock", assetsDir: path.join(dir, "assets") };
    const app = buildServer({ store, logger: console, config, floorplanStore });
    await app.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

    const listEmpty = await fetch(`${baseUrl}/floorplans`);
    assert.equal(listEmpty.status, 200);
    const emptyJson = await listEmpty.json();
    assert.equal(emptyJson.count, 0);

    const createdRes = await fetch(`${baseUrl}/floorplans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPlan())
    });
    assert.equal(createdRes.status, 200);
    const created = await createdRes.json();
    assert.equal(created.id, "floor1");

    const listRes = await fetch(`${baseUrl}/floorplans`);
    const listJson = await listRes.json();
    assert.equal(listJson.count, 1);

    const detailRes = await fetch(`${baseUrl}/floorplans/floor1`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.id, "floor1");

    const updateRes = await fetch(`${baseUrl}/floorplans/floor1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...buildPlan(), name: "二层" })
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.name, "二层");

    const deleteRes = await fetch(`${baseUrl}/floorplans/floor1`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    const deleted = await deleteRes.json();
    assert.equal(deleted.status, "deleted");

    await app.close();
  });
});
