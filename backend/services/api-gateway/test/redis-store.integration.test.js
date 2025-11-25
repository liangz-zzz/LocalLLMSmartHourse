import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RedisStore } from "../src/store.js";
import { buildServer } from "../src/server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const samplePath = path.resolve(__dirname, "../src/fixtures/living_room_plug.json");

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";

test("gateway reads devices from Redis store", async () => {
  const sample = JSON.parse(await fs.readFile(samplePath, "utf8"));
  const prefix = `test_gateway_${Date.now()}`;
  const store = new RedisStore({ redisUrl, prefix });

  await store.clearTestPrefix();
  await store.upsert(sample);

  const app = buildServer({ store, logger: console, config: { mode: "redis" } });
  await app.listen({ port: 0 });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const listRes = await fetch(`${baseUrl}/devices`);
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json();
  assert.equal(listJson.count, 1);
  assert.equal(listJson.items[0].id, sample.id);

  const detailRes = await fetch(`${baseUrl}/devices/${sample.id}`);
  assert.equal(detailRes.status, 200);

  await app.close();
  await store.clearTestPrefix();
  await store.close();
});
