import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import { MockStore } from "../src/store.js";
import { FloorplanStore } from "../src/floorplan-store.js";
import { DeviceOverridesStore } from "../src/device-overrides-store.js";

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
    imageScale: {
      points: [
        { x: 0.12, y: 0.12 },
        { x: 0.42, y: 0.12 }
      ],
      distanceMeters: 4.6
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
    assert.equal(detail.imageScale.distanceMeters, 4.6);

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

test("floorplan updates persist physical coordinates for devices and voice satellites", async () => {
  await withTempDir(async (dir) => {
    const samplePath = new URL("../src/fixtures/living_room_plug.json", import.meta.url);
    const store = new MockStore(samplePath);
    await store.init();
    const floorplanStore = new FloorplanStore({ floorplansPath: path.join(dir, "floorplans.json") });
    const deviceOverridesPath = path.join(dir, "devices.config.json");
    await fs.writeFile(
      deviceOverridesPath,
      JSON.stringify(
        {
          voice_control: {
            mics: [
              {
                id: "living-room-respeaker",
                placement: {
                  room: "living_room"
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
    const deviceOverridesStore = new DeviceOverridesStore({ deviceOverridesPath });
    const config = { mode: "mock", assetsDir: path.join(dir, "assets") };
    const app = buildServer({ store, logger: console, config, floorplanStore, deviceOverridesStore });
    await app.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

    const payload = {
      ...buildPlan(),
      devices: [
        { deviceId: "living-room-respeaker", x: 0.62, y: 0.18, height: 1.1 },
        { deviceId: "plug_living_room_1", x: 0.5, y: 0.25, height: 0.4 }
      ]
    };
    const createdRes = await fetch(`${baseUrl}/floorplans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    assert.equal(createdRes.status, 200);

    const saved = JSON.parse(await fs.readFile(deviceOverridesPath, "utf8"));
    const metersPerPixel = 4.6 / 300;
    const micCoordinates = saved.voice_control.mics[0].placement.coordinates;
    assert.ok(Math.abs(micCoordinates.x - 0.62 * 1000 * metersPerPixel) < 1e-12);
    assert.ok(Math.abs(micCoordinates.y - 0.18 * 800 * metersPerPixel) < 1e-12);
    assert.equal(micCoordinates.z, 1.1);
    assert.equal(micCoordinates.unit, "m");
    assert.equal(micCoordinates.floorplanId, "floor1");

    const plugOverride = saved.devices.find((item) => item.id === "plug_living_room_1");
    assert.ok(plugOverride);
    assert.ok(Math.abs(plugOverride.placement.coordinates.x - 0.5 * 1000 * metersPerPixel) < 1e-12);
    assert.equal(plugOverride.placement.coordinates.source, "floorplan");

    const deviceRes = await fetch(`${baseUrl}/devices/plug_living_room_1`);
    assert.equal(deviceRes.status, 200);
    const device = await deviceRes.json();
    assert.equal(device.placement.coordinates.floorplanId, "floor1");
    assert.equal(device.placement.coordinates.z, 0.4);

    const rescaledPayload = {
      ...payload,
      imageScale: { ...payload.imageScale, distanceMeters: 9.2 }
    };
    const rescaleRes = await fetch(`${baseUrl}/floorplans/floor1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rescaledPayload)
    });
    assert.equal(rescaleRes.status, 200);
    const rescaled = JSON.parse(await fs.readFile(deviceOverridesPath, "utf8"));
    const rescaledPlug = rescaled.devices.find((item) => item.id === "plug_living_room_1");
    assert.ok(Math.abs(rescaledPlug.placement.coordinates.x - 0.5 * 1000 * (9.2 / 300)) < 1e-12);
    assert.ok(Math.abs(rescaled.voice_control.mics[0].placement.coordinates.y - 0.18 * 800 * (9.2 / 300)) < 1e-12);

    const updateRes = await fetch(`${baseUrl}/floorplans/floor1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, devices: [] })
    });
    assert.equal(updateRes.status, 200);
    const cleared = JSON.parse(await fs.readFile(deviceOverridesPath, "utf8"));
    assert.equal(cleared.devices.some((item) => item.id === "plug_living_room_1"), false);
    assert.equal(cleared.voice_control.mics[0].placement.coordinates, undefined);

    await app.close();
  });
});
