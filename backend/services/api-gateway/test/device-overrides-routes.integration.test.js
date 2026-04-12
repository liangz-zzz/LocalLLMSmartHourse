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

test("device overrides routes expose and sync voice satellite placement", async () => {
  await withTempDir(async (dir) => {
    const samplePath = new URL("../src/fixtures/living_room_plug.json", import.meta.url);
    const store = new MockStore(samplePath);
    await store.init();
    const filePath = path.join(dir, "devices.config.json");
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          voice_control: {
            mics: [
              {
                id: "living-room-respeaker",
                placement: {
                  room: "living_room",
                  coordinates: { x: 0.2, y: 0.3 }
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
    const deviceOverridesStore = new DeviceOverridesStore({ deviceOverridesPath: filePath });
    const config = { mode: "mock", assetsDir: path.join(dir, "assets") };
    const app = buildServer({ store, logger: console, config, deviceOverridesStore });
    await app.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

    const getRes = await fetch(`${baseUrl}/device-overrides/living-room-respeaker`);
    assert.equal(getRes.status, 200);
    const initial = await getRes.json();
    assert.equal(initial.placement.room, "living_room");
    assert.equal(initial.placement.coordinates.x, 0.2);

    const updateRes = await fetch(`${baseUrl}/device-overrides/living-room-respeaker`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "living-room-respeaker",
        name: "Living Room ReSpeaker Lite",
        placement: { room: "living_room", zone: "tv_wall" }
      })
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.name, "Living Room ReSpeaker Lite");
    assert.equal(updated.placement.zone, "tv_wall");
    assert.equal(updated.semantics.tags.includes("voice"), true);

    const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(saved.devices[0].id, "living-room-respeaker");
    assert.equal(saved.voice_control.mics[0].name, "Living Room ReSpeaker Lite");
    assert.equal(saved.voice_control.mics[0].placement.room, "living_room");
    assert.equal(saved.voice_control.mics[0].placement.zone, "tv_wall");

    await app.close();
  });
});
