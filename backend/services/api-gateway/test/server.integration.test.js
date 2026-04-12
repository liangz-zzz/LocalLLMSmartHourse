import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { buildServer } from "../src/server.js";
import { MockStore } from "../src/store.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceOverridesStore } from "../src/device-overrides-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const samplePath = path.resolve(__dirname, "../src/fixtures/living_room_plug.json");

test("GET /devices and /devices/:id return data from store", async (t) => {
  const store = new MockStore(samplePath);
  await store.init();
  const app = buildServer({ store, logger: console, config: { mode: "mock" } });
  await app.listen({ port: 0 });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const listRes = await fetch(`${baseUrl}/devices`);
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json();
  assert.equal(listJson.count, 1);
  assert.equal(listJson.items[0].id, "plug_living_room_1");
  assert.equal(typeof listJson.items[0].identity?.stableKey, "string");

  const detailRes = await fetch(`${baseUrl}/devices/plug_living_room_1`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.id, "plug_living_room_1");
  assert.equal(typeof detail.identity?.stableKey, "string");

  const notFound = await fetch(`${baseUrl}/devices/unknown`);
  assert.equal(notFound.status, 404);

  await app.close();
});

test("GET /devices includes voice satellite registrations from devices.config.json", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "server-integration-"));
  try {
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
                name: "Living Room ReSpeaker Lite",
                placement: {
                  room: "living_room",
                  coordinates: { x: 0.4, y: 0.6 }
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
    const app = buildServer({ store, logger: console, config: { mode: "mock" }, deviceOverridesStore });
    await app.listen({ port: 0 });
    const address = app.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const listRes = await fetch(`${baseUrl}/devices`);
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.count, 2);
    const voiceDevice = listJson.items.find((item) => item.id === "living-room-respeaker");
    assert.equal(voiceDevice.protocol, "voice_satellite");
    assert.equal(voiceDevice.placement.room, "living_room");
    assert.equal(voiceDevice.traits.availability.state, "online");

    const detailRes = await fetch(`${baseUrl}/devices/living-room-respeaker`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.id, "living-room-respeaker");
    assert.equal(detail.protocol, "voice_satellite");

    await app.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
