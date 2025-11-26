import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { DbStore } from "../src/store.js";
import { buildServer } from "../src/server.js";

process.env.DATABASE_URL ||= "postgres://smarthome:smarthome@db:5432/smarthome";
const prisma = new PrismaClient();

const sampleDevice = {
  id: `db_test_${Date.now()}`,
  name: "DB Test Plug",
  placement: { room: "lab" },
  protocol: "zigbee",
  bindings: { ha_entity_id: "switch.db_test" },
  capabilities: [{ action: "turn_on" }],
  semantics: { tags: ["test"] }
};

const sampleTraits = { switch: { state: "on" } };

test("DbStore list/get returns merged latest state", async () => {
  await prisma.device.create({
    data: { ...sampleDevice, semantics: sampleDevice.semantics }
  });
  await prisma.deviceState.create({
    data: {
      deviceId: sampleDevice.id,
      traits: sampleTraits
    }
  });

  const store = new DbStore({ databaseUrl: process.env.DATABASE_URL });
  const list = await store.list();
  const found = list.find((d) => d.id === sampleDevice.id);
  assert.ok(found);
  assert.equal(found.traits.switch.state, "on");

  const single = await store.get(sampleDevice.id);
  assert.equal(single.id, sampleDevice.id);
  assert.equal(single.traits.switch.state, "on");

  await store.close();
});

test("HTTP endpoints work with DbStore", async () => {
  const store = new DbStore({ databaseUrl: process.env.DATABASE_URL });
  const app = buildServer({ store, logger: console, config: { mode: "db" } });
  await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const res = await fetch(`${base}/devices/${sampleDevice.id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, sampleDevice.id);

  await app.close();
  await store.close();
});

test.after(async () => {
  await prisma.deviceState.deleteMany({ where: { deviceId: sampleDevice.id } });
  await prisma.device.deleteMany({ where: { id: sampleDevice.id } });
  await prisma.$disconnect();
});
