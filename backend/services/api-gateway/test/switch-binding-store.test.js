import test from "node:test";
import assert from "node:assert/strict";

import { SwitchBindingStore } from "../src/switch-binding-store.js";

class MemoryAutomationStore {
  constructor() {
    this.items = [];
  }

  async list() {
    return structuredClone(this.items);
  }

  async get(id) {
    return structuredClone(this.items.find((item) => item.id === id));
  }

  async create(item) {
    this.items.push(structuredClone(item));
    return item;
  }

  async update(id, item) {
    const index = this.items.findIndex((candidate) => candidate.id === id);
    this.items[index] = structuredClone({ ...item, id });
    return item;
  }

  async delete(id) {
    this.items = this.items.filter((item) => item.id !== id);
    return { removed: id };
  }
}

const devices = [
  panel("panel1", ["left", "right"]),
  channel("panel1:left", "panel1", "left"),
  channel("panel1:right", "panel1", "right"),
  panel("panel2", ["left", "center", "right"]),
  channel("panel2:left", "panel2", "left"),
  channel("panel2:center", "panel2", "center"),
  channel("panel2:right", "panel2", "right"),
  {
    id: "ceiling-light",
    name: "顶灯",
    capabilities: [{ action: "turn_on" }, { action: "turn_off" }, { action: "set_brightness", parameters: [{ name: "brightness", type: "number", minimum: 0, maximum: 100, required: true }] }]
  }
];

function makeStore() {
  const automationStore = new MemoryAutomationStore();
  return {
    automationStore,
    store: new SwitchBindingStore({
      automationStore,
      deviceStore: { async list() { return devices; } },
      sceneStore: { async get(id) { return id === "welcome" ? { id, name: "回家" } : undefined; } }
    })
  };
}

test("SwitchBindingStore compiles ordered multi-target button bindings into automations", async () => {
  const { store, automationStore } = makeStore();
  const created = await store.create({
    id: "panel1_left_single",
    name: "左键回家",
    enabled: true,
    source: { panelId: "panel1", selector: "left", trigger: { type: "button", gesture: "single" } },
    targets: [
      { type: "device", deviceId: "ceiling-light", action: "set_brightness", params: { brightness: 80 } },
      { type: "scene", sceneId: "welcome" }
    ]
  });

  assert.equal(created.targets.length, 2);
  const [compiled] = await automationStore.list();
  assert.equal(compiled.kind, "switch_binding");
  assert.deepEqual(compiled.trigger, {
    type: "device_event",
    deviceId: "panel1",
    eventType: "button",
    gesture: "single",
    selector: "left"
  });
  assert.deepEqual(compiled.then, created.targets);
  assert.deepEqual(await store.list({ panelId: "panel1" }), [created]);

  const validatedUpdate = await store.validate({ ...created, name: "只校验不保存" }, { currentId: created.id });
  assert.equal(validatedUpdate.name, "只校验不保存");
  assert.equal((await automationStore.list())[0].name, "左键回家");
});

test("SwitchBindingStore supports relay-state sources and rejects duplicate source assignments", async () => {
  const { store, automationStore } = makeStore();
  await store.create({
    id: "state_binding",
    name: "右路打开时关顶灯",
    source: { panelId: "panel1", selector: "right", trigger: { type: "state", value: "on" } },
    targets: [{ type: "device", deviceId: "ceiling-light", action: "turn_off" }]
  });

  assert.deepEqual((await automationStore.list())[0].trigger, {
    type: "device",
    deviceId: "panel1:right",
    traitPath: "traits.switch.state",
    operator: "eq",
    value: "on",
    changed: true
  });
  await assert.rejects(
    () =>
      store.create({
        id: "duplicate",
        name: "重复来源",
        source: { panelId: "panel1", selector: "right", trigger: { type: "state", value: "on" } },
        targets: [{ type: "device", deviceId: "ceiling-light", action: "turn_on" }]
      }),
    (err) => err?.code === "switch_binding_exists"
  );
});

test("SwitchBindingStore validates combos, action params, self-targets and state cycles", async () => {
  const { store } = makeStore();
  await store.create({
    id: "combo",
    name: "组合键",
    source: { panelId: "panel2", selector: "left_center", trigger: { type: "button", gesture: "double" } },
    targets: [{ type: "scene", sceneId: "welcome" }]
  });

  await assert.rejects(
    () =>
      store.create({
        id: "unsupported_combo",
        name: "双键错误组合",
        source: { panelId: "panel1", selector: "left_right", trigger: { type: "button", gesture: "single" } },
        targets: [{ type: "scene", sceneId: "welcome" }]
      }),
    (err) => err?.code === "invalid_switch_binding" && err.message.includes("not available")
  );

  await assert.rejects(
    () =>
      store.create({
        id: "invalid_params",
        name: "参数越界",
        source: { panelId: "panel1", selector: "left", trigger: { type: "button", gesture: "double" } },
        targets: [{ type: "device", deviceId: "ceiling-light", action: "set_brightness", params: { brightness: 101 } }]
      }),
    (err) => err?.code === "invalid_switch_binding" && err.message.includes("maximum")
  );
  await assert.rejects(
    () =>
      store.create({
        id: "self_target",
        name: "自触发",
        source: { panelId: "panel1", selector: "left", trigger: { type: "state", value: "on" } },
        targets: [{ type: "device", deviceId: "panel1:left", action: "turn_off" }]
      }),
    (err) => err?.code === "invalid_switch_binding" && err.message.includes("own source")
  );

  await store.create({
    id: "cycle_a",
    name: "循环 A",
    source: { panelId: "panel1", selector: "left", trigger: { type: "state", value: "off" } },
    targets: [{ type: "device", deviceId: "panel2:left", action: "turn_on" }]
  });
  await assert.rejects(
    () =>
      store.create({
        id: "cycle_b",
        name: "循环 B",
        source: { panelId: "panel2", selector: "left", trigger: { type: "state", value: "off" } },
        targets: [{ type: "device", deviceId: "panel1:left", action: "turn_on" }]
      }),
    (err) => err?.code === "invalid_switch_binding" && err.message.includes("cycle")
  );
});

function panel(id, endpoints) {
  return {
    id,
    name: id,
    composition: { role: "panel", childIds: endpoints.map((endpoint) => `${id}:${endpoint}`) },
    capabilities: []
  };
}

function channel(id, parentId, endpoint) {
  return {
    id,
    name: id,
    composition: { role: "relay_channel", parentId, endpoint },
    capabilities: [{ action: "turn_on" }, { action: "turn_off" }, { action: "toggle" }]
  };
}
