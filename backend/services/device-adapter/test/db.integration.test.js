import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { MemoryStore } from "../src/store.js";
import { normalizeZigbee2Mqtt } from "../src/normalize.js";
import { ensureDatabaseUrl, upsertDeviceAndState } from "../src/db.js";

const prisma = new PrismaClient();
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("persists device and state to Postgres when dbEnabled", async () => {
  const deviceMeta = JSON.parse(await fs.readFile(path.join(root, "mock-data/zigbee2mqtt/device.json"), "utf8"));
  const deviceState = JSON.parse(await fs.readFile(path.join(root, "mock-data/zigbee2mqtt/state.json"), "utf8"));
  const normalized = normalizeZigbee2Mqtt({ device: deviceMeta, state: deviceState });

  ensureDatabaseUrl(process.env.DATABASE_URL || "postgres://smarthome:smarthome@db:5432/smarthome");

  // mimic adapter store + db write
  const store = new MemoryStore();
  await store.upsert(normalized);
  await upsertDeviceAndState(normalized);

  const saved = await prisma.device.findUnique({
    where: { id: normalized.id },
    include: { states: { orderBy: { createdAt: "desc" }, take: 1 } }
  });

  assert.ok(saved);
  assert.equal(saved.name, normalized.name);
  assert.ok(saved.states[0]);
  assert.equal(saved.states[0].traits.switch.state, "on");

  await prisma.deviceState.deleteMany({ where: { deviceId: normalized.id } });
  await prisma.device.deleteMany({ where: { id: normalized.id } });
});

test.after(async () => {
  await prisma.$disconnect();
});
