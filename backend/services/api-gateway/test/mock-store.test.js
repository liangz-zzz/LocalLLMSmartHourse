import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockStore } from "../src/store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const samplePath = path.resolve(__dirname, "../src/fixtures/living_room_plug.json");

test("MockStore loads sample device", async () => {
  const store = new MockStore(samplePath);
  await store.init();
  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "plug_living_room_1");
  const device = await store.get("plug_living_room_1");
  assert.ok(device);
});
