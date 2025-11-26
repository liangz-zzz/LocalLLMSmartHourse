import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.js";

const device = {
  id: "plug1",
  name: "plug",
  placement: { room: "lab" },
  protocol: "zigbee",
  bindings: {},
  traits: { switch: { state: "off" } },
  capabilities: [{ action: "turn_on" }]
};

class FakeStore {
  async get(id) {
    if (id === device.id) return device;
    return undefined;
  }
  async list() {
    return [device];
  }
}

class FakeBus {
  constructor() {
    this.published = [];
  }
  async publishAction(action) {
    this.published.push(action);
  }
}

test("actions route validates device and capability", async () => {
  const bus = new FakeBus();
  const app = buildServer({ store: new FakeStore(), logger: console, config: { mode: "mock" }, bus });
  await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const ok = await fetch(`${base}/devices/plug1/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "turn_on" })
  });
  assert.equal(ok.status, 200);
  assert.equal(bus.published.length, 1);

  const bad = await fetch(`${base}/devices/plug1/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "set_brightness" })
  });
  assert.equal(bad.status, 400);

  const missing = await fetch(`${base}/devices/unknown/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "turn_on" })
  });
  assert.equal(missing.status, 404);

  await app.close();
});
