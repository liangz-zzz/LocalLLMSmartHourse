import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import { MockStore } from "../src/store.js";
import { AutomationStore } from "../src/automation-store.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "automations-routes-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildAutomation() {
  return {
    id: "auto1",
    name: "测试联动",
    enabled: true,
    trigger: { type: "interval", everyMs: 60_000 },
    when: { time: { after: "22:30", before: "07:00" } },
    then: [{ type: "scene", sceneId: "sleep" }]
  };
}

test("automations routes support CRUD and validation", async () => {
  await withTempDir(async (dir) => {
    const samplePath = new URL("../src/fixtures/living_room_plug.json", import.meta.url);
    const store = new MockStore(samplePath);
    await store.init();
    const automationStore = new AutomationStore({ automationsPath: path.join(dir, "automations.json") });
    const config = { mode: "mock", assetsDir: path.join(dir, "assets") };
    const app = buildServer({ store, logger: console, config, automationStore });
    await app.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

    const listEmptyRes = await fetch(`${baseUrl}/automations`);
    assert.equal(listEmptyRes.status, 200);
    const listEmpty = await listEmptyRes.json();
    assert.equal(listEmpty.count, 0);

    const invalidRes = await fetch(`${baseUrl}/automations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bad" })
    });
    assert.equal(invalidRes.status, 400);
    const invalidJson = await invalidRes.json();
    assert.equal(invalidJson.error, "invalid_automations");

    const createdRes = await fetch(`${baseUrl}/automations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildAutomation())
    });
    assert.equal(createdRes.status, 200);
    const created = await createdRes.json();
    assert.equal(created.id, "auto1");

    const listRes = await fetch(`${baseUrl}/automations`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.count, 1);

    const getRes = await fetch(`${baseUrl}/automations/auto1`);
    assert.equal(getRes.status, 200);
    const got = await getRes.json();
    assert.equal(got.name, "测试联动");

    const updateMismatchRes = await fetch(`${baseUrl}/automations/auto1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...buildAutomation(), id: "auto2" })
    });
    assert.equal(updateMismatchRes.status, 400);

    const updateRes = await fetch(`${baseUrl}/automations/auto1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...buildAutomation(), name: "更新后的联动" })
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.name, "更新后的联动");

    const deleteRes = await fetch(`${baseUrl}/automations/auto1`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    const deleted = await deleteRes.json();
    assert.equal(deleted.status, "deleted");

    const listAfterDelRes = await fetch(`${baseUrl}/automations`);
    const listAfterDel = await listAfterDelRes.json();
    assert.equal(listAfterDel.count, 0);

    await app.close();
  });
});

