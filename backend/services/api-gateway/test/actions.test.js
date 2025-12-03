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
  capabilities: [
    { action: "turn_on" },
    { action: "set_brightness", parameters: [{ name: "brightness", type: "number", minimum: 0, maximum: 100 }] },
    { action: "mode_enum", parameters: [{ name: "mode", type: "enum", enum: ["a", "b"] }] },
    { action: "strict_required", parameters: [{ name: "required_param", type: "string", required: true }] }
  ]
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
    body: JSON.stringify({ action: "set_brightness", params: { brightness: 200 } })
  });
  assert.equal(bad.status, 400);

  const badEnum = await fetch(`${base}/devices/plug1/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "mode_enum", params: { mode: "c" } })
  });
  assert.equal(badEnum.status, 400);

  const missingRequired = await fetch(`${base}/devices/plug1/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "strict_required", params: {} })
  });
  assert.equal(missingRequired.status, 400);

  const missing = await fetch(`${base}/devices/unknown/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "turn_on" })
  });
  assert.equal(missing.status, 404);

  await app.close();
});
