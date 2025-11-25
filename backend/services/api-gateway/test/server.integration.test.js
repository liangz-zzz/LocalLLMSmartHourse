import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.js";
import { MockStore } from "../src/store.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

  const detailRes = await fetch(`${baseUrl}/devices/plug_living_room_1`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.id, "plug_living_room_1");

  const notFound = await fetch(`${baseUrl}/devices/unknown`);
  assert.equal(notFound.status, 404);

  await app.close();
});
