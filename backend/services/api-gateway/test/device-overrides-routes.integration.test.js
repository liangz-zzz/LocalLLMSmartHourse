import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import { MockStore } from "../src/store.js";
import { DeviceOverridesStore } from "../src/device-overrides-store.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "device-overrides-routes-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildOverride() {
  return {
    id: "kettle_plug",
    name: "烧水壶插座",
    placement: { room: "kitchen", zone: "counter" },
    semantics: { aliases: ["烧水壶", "水壶"], tags: ["kettle", "plug"] }
  };
}

test("device overrides routes support CRUD", async () => {
  await withTempDir(async (dir) => {
    const samplePath = new URL("../src/fixtures/living_room_plug.json", import.meta.url);
    const store = new MockStore(samplePath);
    await store.init();
    const deviceOverridesStore = new DeviceOverridesStore({ deviceOverridesPath: path.join(dir, "devices.config.json") });
    const config = { mode: "mock", assetsDir: path.join(dir, "assets") };
    const app = buildServer({ store, logger: console, config, deviceOverridesStore });
    await app.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

    const listEmptyRes = await fetch(`${baseUrl}/device-overrides`);
    assert.equal(listEmptyRes.status, 200);
    const listEmpty = await listEmptyRes.json();
    assert.equal(listEmpty.count, 0);

    const missingRes = await fetch(`${baseUrl}/device-overrides/kettle_plug`);
    assert.equal(missingRes.status, 404);

    const upsertRes = await fetch(`${baseUrl}/device-overrides/kettle_plug`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildOverride())
    });
    assert.equal(upsertRes.status, 200);
    const upserted = await upsertRes.json();
    assert.equal(upserted.id, "kettle_plug");
    assert.equal(upserted.name, "烧水壶插座");

    const listRes = await fetch(`${baseUrl}/device-overrides`);
    const list = await listRes.json();
    assert.equal(list.count, 1);

    const getRes = await fetch(`${baseUrl}/device-overrides/kettle_plug`);
    assert.equal(getRes.status, 200);
    const got = await getRes.json();
    assert.equal(got.placement.room, "kitchen");

    const mismatchRes = await fetch(`${baseUrl}/device-overrides/kettle_plug`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...buildOverride(), id: "other" })
    });
    assert.equal(mismatchRes.status, 400);

    const updateRes = await fetch(`${baseUrl}/device-overrides/kettle_plug`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...buildOverride(), name: "水壶插座(更新)" })
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.name, "水壶插座(更新)");

    const deleteRes = await fetch(`${baseUrl}/device-overrides/kettle_plug`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    const deleted = await deleteRes.json();
    assert.equal(deleted.status, "deleted");

    const listAfterRes = await fetch(`${baseUrl}/device-overrides`);
    const listAfter = await listAfterRes.json();
    assert.equal(listAfter.count, 0);

    await app.close();
  });
});

