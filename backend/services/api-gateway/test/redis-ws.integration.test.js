import test from "node:test";
import assert from "node:assert/strict";
import ws from "ws";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RedisStore } from "../src/store.js";
import { RedisBus } from "../src/bus.js";
import { buildServer } from "../src/server.js";
import { setupWs } from "../src/ws.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const samplePath = path.resolve(__dirname, "../src/fixtures/living_room_plug.json");

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";

test("gateway websocket streams device updates from Redis", async () => {
  const sample = JSON.parse(await fs.readFile(samplePath, "utf8"));
  const prefix = `test_gateway_${Date.now()}`;
  const store = new RedisStore({ redisUrl, prefix });
  await store.clearTestPrefix();

  const bus = new RedisBus({
    redisUrl,
    updatesChannel: "device:updates",
    actionsChannel: "device:actions",
    logger: console
  });
  await bus.start();

  const app = buildServer({
    store,
    logger: console,
    config: { mode: "redis" },
    bus
  });
  await app.listen({ port: 0 });
  const { stop: stopWs } = setupWs({ server: app.server, bus, mode: "redis", logger: console });
  const port = app.server.address().port;
  const client = new ws(`ws://127.0.0.1:${port}/ws`);

  const messages = [];
  client.on("message", (data) => {
    messages.push(JSON.parse(data.toString()));
  });

  // write device and emit update
  await store.upsert(sample); // publish happens inside store when using RedisStore in adapter; here we mimic via bus
  await bus.publishAction({ id: "noop", action: "noop" }); // ensure publish works
  await bus.pub.publish("device:updates", JSON.stringify(sample));

  await waitFor(() => messages.find((m) => m.type === "device_update"), 5000);
  const update = messages.find((m) => m.type === "device_update");
  assert.equal(update.data.id, sample.id);

  client.close();
  client.close();
  await stopWs();
  await app.close();
  await bus.stop();
  await store.clearTestPrefix();
  await store.close();
});

async function waitFor(fn, timeoutMs = 2000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timeout");
}
