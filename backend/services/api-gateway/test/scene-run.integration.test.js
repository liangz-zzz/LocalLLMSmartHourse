import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import { SceneStore } from "../src/scene-store.js";
import { SceneRunner } from "../src/scene-runner.js";

class FakeDeviceStore {
  constructor() {
    this.items = new Map([
      [
        "light1",
        {
          id: "light1",
          name: "客厅灯",
          capabilities: [{ action: "turn_on" }, { action: "turn_off" }]
        }
      ],
      [
        "plug1",
        {
          id: "plug1",
          name: "插座",
          capabilities: [{ action: "turn_on" }]
        }
      ]
    ]);
  }

  async get(id) {
    return this.items.get(id);
  }

  async list() {
    return Array.from(this.items.values());
  }
}

class FakeBus {
  constructor({ outcomes = {} } = {}) {
    this.outcomes = outcomes;
    this.handlers = new Set();
    this.published = [];
  }

  onActionResult(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async publishAction(action) {
    this.published.push(action);
    const key = `${action.id}:${action.action}`;
    const outcome = this.outcomes[key] || { status: "ok" };
    if (outcome === "timeout") return;

    setTimeout(() => {
      const payload = {
        id: `${key}:${Date.now()}`,
        deviceId: action.id,
        action: action.action,
        status: outcome.status || "ok",
        reason: outcome.reason,
        transport: "fake_bus",
        ts: Date.now()
      };
      for (const handler of this.handlers) handler(payload);
    }, 5);
  }
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scene-run-routes-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("scene run endpoint aggregates action results", async () => {
  await withTempDir(async (dir) => {
    const sceneStore = new SceneStore({ scenesPath: path.join(dir, "scenes.json") });
    await sceneStore.create({
      id: "night",
      name: "夜间",
      description: "关灯并开插座",
      steps: [
        { type: "device", deviceId: "light1", action: "turn_off", params: {} },
        { type: "device", deviceId: "plug1", action: "turn_on", params: {} }
      ]
    });

    const store = new FakeDeviceStore();
    const bus = new FakeBus({
      outcomes: {
        "light1:turn_off": { status: "ok" },
        "plug1:turn_on": { status: "error", reason: "simulated_failure" }
      }
    });
    const sceneRunner = new SceneRunner({
      sceneStore,
      store,
      bus,
      defaultTimeoutMs: 200
    });

    const app = buildServer({
      store,
      logger: console,
      config: { mode: "mock", assetsDir: path.join(dir, "assets") },
      sceneStore,
      sceneRunner
    });
    const runRes = await app.inject({
      method: "POST",
      url: "/scenes/night/run",
      payload: { confirm: true }
    });
    assert.equal(runRes.statusCode, 200);
    const run = runRes.json();
    assert.equal(run.sceneId, "night");
    assert.equal(run.status, "partial_ok");
    assert.equal(run.steps.length, 2);
    assert.equal(run.steps[0].status, "ok");
    assert.equal(run.steps[1].status, "error");
    assert.equal(run.steps[1].reason, "simulated_failure");

    await app.close();
  });
});

test("scene run endpoint supports dryRun and requires confirm for real run", async () => {
  await withTempDir(async (dir) => {
    const sceneStore = new SceneStore({ scenesPath: path.join(dir, "scenes.json") });
    await sceneStore.create({
      id: "sleep",
      name: "睡眠",
      description: "关灯",
      steps: [{ type: "device", deviceId: "light1", action: "turn_off", params: {} }]
    });

    const store = new FakeDeviceStore();
    const bus = new FakeBus();
    const sceneRunner = new SceneRunner({
      sceneStore,
      store,
      bus,
      defaultTimeoutMs: 200
    });

    const app = buildServer({
      store,
      logger: console,
      config: { mode: "mock", assetsDir: path.join(dir, "assets") },
      sceneStore,
      sceneRunner
    });
    const noConfirmRes = await app.inject({
      method: "POST",
      url: "/scenes/sleep/run",
      payload: {}
    });
    assert.equal(noConfirmRes.statusCode, 400);
    const noConfirm = noConfirmRes.json();
    assert.equal(noConfirm.error, "confirmation_required");

    const dryRunRes = await app.inject({
      method: "POST",
      url: "/scenes/sleep/run",
      payload: { dryRun: true }
    });
    assert.equal(dryRunRes.statusCode, 200);
    const dryRun = dryRunRes.json();
    assert.equal(dryRun.status, "ok");
    assert.equal(dryRun.steps[0].status, "dry_run");

    await app.close();
  });
});
