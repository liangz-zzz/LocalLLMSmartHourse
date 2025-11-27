import test from "node:test";
import assert from "node:assert/strict";
import { ActionResultStore } from "../src/action-store.js";
import { buildServer } from "../src/server.js";

process.env.DATABASE_URL ||= "postgres://smarthome:smarthome@db:5432/smarthome";

const sampleDevice = {
  id: "plug_store_test",
  name: "plug",
  placement: { room: "lab" },
  protocol: "zigbee",
  bindings: {},
  traits: { switch: { state: "off" } },
  capabilities: [{ action: "turn_on" }]
};

class FakeStore {
  async get(id) {
    return id === sampleDevice.id ? sampleDevice : undefined;
  }
  async list() {
    return [sampleDevice];
  }
}

test("action results are saved and retrievable via HTTP", async () => {
  const actionStore = new ActionResultStore({ databaseUrl: process.env.DATABASE_URL });
  const id = `act_${Date.now()}`;
  await actionStore.save({
    id,
    deviceId: sampleDevice.id,
    action: "turn_on",
    status: "ok",
    transport: "mqtt",
    params: { brightness: 50 },
    ts: Date.now()
  });

  const app = buildServer({ store: new FakeStore(), logger: console, config: { mode: "db" }, bus: null, actionStore });
  await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const res = await fetch(`${base}/devices/${sampleDevice.id}/actions`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.items.length >= 1);
  assert.equal(body.items[0].deviceId, sampleDevice.id);
  assert.equal(body.items[0].action, "turn_on");

  await app.close();
  await actionStore.prisma.actionResult.delete({ where: { id } });
  await actionStore.prisma.device.deleteMany({ where: { id: sampleDevice.id } });
  await actionStore.close();
});
