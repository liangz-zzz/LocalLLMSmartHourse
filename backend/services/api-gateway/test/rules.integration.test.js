import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.js";
import { RuleStore } from "../src/rule-store.js";

process.env.DATABASE_URL ||= "postgres://smarthome:smarthome@db:5432/smarthome";

class FakeStore {
  async get(id) {
    return { id, name: "dummy", placement: { room: "lab" }, protocol: "virtual", bindings: {}, traits: {}, capabilities: [] };
  }
  async list() {
    return [];
  }
}

test("rules CRUD", async () => {
  const ruleStore = new RuleStore({ databaseUrl: process.env.DATABASE_URL });
  const app = buildServer({ store: new FakeStore(), logger: console, config: { mode: "db" }, bus: null, ruleStore });
  await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const createRes = await fetch(`${base}/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "test_rule", when: { deviceId: "d1" }, then: { action: "turn_on" } })
  });
  assert.equal(createRes.status, 200);

  const listRes = await fetch(`${base}/rules`);
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(list.items.find((r) => r.id === "test_rule"));

  const delRes = await fetch(`${base}/rules/test_rule`, { method: "DELETE" });
  assert.equal(delRes.status, 200);

  await app.close();
  await ruleStore.close();
});
