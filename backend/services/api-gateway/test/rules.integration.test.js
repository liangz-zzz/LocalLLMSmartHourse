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
    body: JSON.stringify({
      id: "test_rule",
      when: { deviceId: "d1", traitPath: "traits.switch.state", equals: "on" },
      then: { action: "turn_on" }
    })
  });
  assert.equal(createRes.status, 200);

  const getRes = await fetch(`${base}/rules/test_rule`);
  assert.equal(getRes.status, 200);
  const single = await getRes.json();
  assert.equal(single.id, "test_rule");

  const badRes = await fetch(`${base}/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "invalid_rule", when: {}, then: {} })
  });
  assert.equal(badRes.status, 400);

  const listRes = await fetch(`${base}/rules`);
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(list.items.find((r) => r.id === "test_rule"));

  const updateRes = await fetch(`${base}/rules/test_rule`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ when: { deviceId: "d1", traitPath: "traits.switch.state", equals: "on" }, then: { action: "turn_off" }, enabled: false })
  });
  assert.equal(updateRes.status, 200);
  const updated = await updateRes.json();
  assert.equal(updated.enabled, false);
  assert.equal(updated.then.action, "turn_off");

  const delRes = await fetch(`${base}/rules/test_rule`, { method: "DELETE" });
  assert.equal(delRes.status, 200);

  await app.close();
  await ruleStore.close();
});
