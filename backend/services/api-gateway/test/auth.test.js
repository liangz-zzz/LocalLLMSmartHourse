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
  async publishAction() {}
}

test("API key is enforced when configured", async () => {
  const app = buildServer({
    store: new FakeStore(),
    logger: console,
    config: { mode: "mock", apiKeys: ["secret"] },
    bus: new FakeBus(),
    actionStore: null,
    ruleStore: null
  });
  await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const unauth = await fetch(`${base}/devices`);
  assert.equal(unauth.status, 401);

  const auth = await fetch(`${base}/devices`, { headers: { "x-api-key": "secret" } });
  assert.equal(auth.status, 200);

  await app.close();
});

test("JWT is accepted when configured", async () => {
  const jwtSecret = "supersecret";
  const app = buildServer({
    store: new FakeStore(),
    logger: console,
    config: { mode: "mock", apiKeys: [], jwtSecret },
    bus: new FakeBus(),
    actionStore: null,
    ruleStore: null
  });
  await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const token = await app.jwt.sign({ sub: "tester" });

  const res = await fetch(`${base}/devices`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);

  await app.close();
});
