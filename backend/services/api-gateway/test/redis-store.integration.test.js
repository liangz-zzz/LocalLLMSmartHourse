import test from "node:test";
import assert from "node:assert/strict";
import { RedisStore } from "../src/store.js";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";

test("RedisStore list/get/upsert roundtrip", async () => {
  const prefix = `test_store_${Date.now()}`;
  const store = new RedisStore({ redisUrl, prefix });
  await store.clearTestPrefix();

  const device = { id: "test1", name: "test", placement: { room: "lab" }, protocol: "virtual", bindings: {}, traits: {}, capabilities: [] };
  await store.upsert(device);

  const list = await store.list();
  assert.equal(list.length, 1);
  const fetched = await store.get("test1");
  assert.equal(fetched.name, "test");

  await store.clearTestPrefix();
  await store.close();
});
