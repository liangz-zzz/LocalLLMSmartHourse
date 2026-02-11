import test from "node:test";
import assert from "node:assert/strict";
import { validateAutomationList } from "../src/automations.js";
import { AutomationEngine } from "../src/automation-engine.js";

class FakeClock {
  constructor() {
    this.nowMs = 0;
    this.nextId = 1;
    this.timeouts = new Map();
    this.intervals = new Map();
  }

  now() {
    return this.nowMs;
  }

  setTimeout(fn, ms) {
    const id = this.nextId++;
    const delay = Math.max(0, Number(ms) || 0);
    this.timeouts.set(id, { id, fn, at: this.nowMs + delay });
    return id;
  }

  clearTimeout(id) {
    this.timeouts.delete(id);
  }

  setInterval(fn, ms) {
    const id = this.nextId++;
    const every = Math.max(1, Number(ms) || 1);
    this.intervals.set(id, { id, fn, everyMs: every, nextAt: this.nowMs + every });
    return id;
  }

  clearInterval(id) {
    this.intervals.delete(id);
  }

  async advance(ms) {
    const target = this.nowMs + Math.max(0, Number(ms) || 0);
    // Run tasks in chronological order up to target.
    while (true) {
      const nextTimeout = minBy(Array.from(this.timeouts.values()), (t) => t.at);
      const nextInterval = minBy(Array.from(this.intervals.values()), (i) => i.nextAt);
      const nextAt = Math.min(
        nextTimeout ? nextTimeout.at : Number.POSITIVE_INFINITY,
        nextInterval ? nextInterval.nextAt : Number.POSITIVE_INFINITY
      );

      if (!Number.isFinite(nextAt) || nextAt > target) break;
      this.nowMs = nextAt;

      if (nextTimeout && nextTimeout.at === nextAt) {
        this.timeouts.delete(nextTimeout.id);
        await nextTimeout.fn();
        continue;
      }

      if (nextInterval && nextInterval.nextAt === nextAt) {
        nextInterval.nextAt += nextInterval.everyMs;
        await nextInterval.fn();
      }
    }
    this.nowMs = target;
  }
}

function minBy(items, selector) {
  let best = null;
  let bestVal = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const v = selector(item);
    if (v < bestVal) {
      best = item;
      bestVal = v;
    }
  }
  return best;
}

async function flushMicrotasks() {
  // Give async tasks a chance to run.
  await Promise.resolve();
  await Promise.resolve();
}

test("validateAutomationList rejects invalid payload", () => {
  assert.throws(
    () => validateAutomationList([{ id: "a1" }]),
    (err) => err?.code === "invalid_automations"
  );
});

test("AutomationEngine triggers device action on changed value", async () => {
  const clock = new FakeClock();
  const published = [];
  const engine = new AutomationEngine({
    clock,
    publishAction: async (action) => published.push(action),
    expandScene: async () => ({ steps: [] }),
    logger: { info() {}, warn() {}, error() {} }
  });

  engine.setAutomations([
    {
      id: "auto1",
      enabled: true,
      trigger: {
        type: "device",
        deviceId: "d1",
        traitPath: "traits.switch.state",
        operator: "eq",
        value: "on",
        changed: true
      },
      then: [{ type: "device", deviceId: "light1", action: "turn_off" }]
    }
  ]);

  engine.handleDeviceUpdate({ id: "d1", traits: { switch: { state: "off" } } });
  engine.handleDeviceUpdate({ id: "d1", traits: { switch: { state: "on" } } });
  await flushMicrotasks();

  assert.equal(published.length, 1);
  assert.equal(published[0].id, "light1");
  assert.equal(published[0].action, "turn_off");
  assert.equal(published[0].actor, "automation:auto1");
});

test("AutomationEngine schedules forMs and cancels when condition becomes false", async () => {
  const clock = new FakeClock();
  const published = [];
  const engine = new AutomationEngine({
    clock,
    publishAction: async (action) => published.push(action),
    expandScene: async () => ({ steps: [] }),
    logger: { info() {}, warn() {}, error() {} }
  });

  engine.setAutomations([
    {
      id: "auto2",
      enabled: true,
      trigger: { type: "device", deviceId: "d1", traitPath: "traits.switch.state", operator: "eq", value: "on", changed: true },
      when: { deviceId: "d1", traitPath: "traits.switch.state", operator: "eq", value: "on" },
      forMs: 1000,
      then: [{ type: "device", deviceId: "light1", action: "turn_off" }]
    }
  ]);

  engine.handleDeviceUpdate({ id: "d1", traits: { switch: { state: "off" } } });
  engine.handleDeviceUpdate({ id: "d1", traits: { switch: { state: "on" } } });
  await flushMicrotasks();
  assert.equal(published.length, 0, "not fired yet");

  // condition becomes false before timer fires -> cancel
  await clock.advance(500);
  engine.handleDeviceUpdate({ id: "d1", traits: { switch: { state: "off" } } });
  await clock.advance(600);
  await flushMicrotasks();
  assert.equal(published.length, 0, "canceled");
});

test("AutomationEngine expands scene and publishes each device step", async () => {
  const clock = new FakeClock();
  const published = [];
  const engine = new AutomationEngine({
    clock,
    publishAction: async (action) => published.push(action),
    expandScene: async (sceneId) => ({
      id: sceneId,
      steps: [
        { type: "device", deviceId: "d2", action: "turn_on" },
        { type: "device", deviceId: "d3", action: "turn_off", params: { foo: "bar" } }
      ]
    }),
    logger: { info() {}, warn() {}, error() {} }
  });

  engine.setAutomations([
    {
      id: "auto3",
      enabled: true,
      trigger: { type: "device", deviceId: "d1" },
      then: [{ type: "scene", sceneId: "scene1" }]
    }
  ]);

  engine.handleDeviceUpdate({ id: "d1", traits: {} });
  await flushMicrotasks();

  assert.equal(published.length, 2);
  assert.equal(published[0].id, "d2");
  assert.equal(published[0].action, "turn_on");
  assert.equal(published[1].id, "d3");
  assert.deepEqual(published[1].params, { foo: "bar" });
});

test("AutomationEngine interval trigger fires repeatedly", async () => {
  const clock = new FakeClock();
  const published = [];
  const engine = new AutomationEngine({
    clock,
    publishAction: async (action) => published.push(action),
    expandScene: async () => ({ steps: [] }),
    logger: { info() {}, warn() {}, error() {} }
  });

  engine.setAutomations([
    {
      id: "auto4",
      enabled: true,
      trigger: { type: "interval", everyMs: 1000 },
      then: [{ type: "device", deviceId: "light1", action: "toggle" }]
    }
  ]);

  await clock.advance(1000);
  await flushMicrotasks();
  await clock.advance(1000);
  await flushMicrotasks();
  await clock.advance(1000);
  await flushMicrotasks();

  assert.equal(published.length, 3);
  assert.equal(published[0].action, "toggle");
});
