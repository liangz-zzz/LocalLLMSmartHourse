import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DeviceSimulator, SIMULATOR_SOURCE_FLAG } from "../src/simulator.js";
import { Logger } from "../src/log.js";

class InMemorySimulatorStore {
  constructor() {
    this.map = new Map();
    this.actionResults = [];
    this.stateSnapshots = [];
  }

  async upsert(device) {
    this.map.set(device.id, JSON.parse(JSON.stringify(device)));
  }

  async get(id) {
    const value = this.map.get(id);
    return value ? JSON.parse(JSON.stringify(value)) : undefined;
  }

  async publishActionResult(result) {
    this.actionResults.push(JSON.parse(JSON.stringify(result)));
  }

  async publishStateSnapshot(device) {
    this.stateSnapshots.push({ id: device.id, traits: JSON.parse(JSON.stringify(device.traits || {})) });
  }
}

async function withConfig(payload, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "device-simulator-"));
  const filePath = path.join(dir, "devices.config.json");
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function baseDevice(extra = {}) {
  return {
    id: "sim_light_lr",
    name: "客厅模拟灯",
    placement: { room: "living_room" },
    protocol: "virtual",
    bindings: {},
    traits: { switch: { state: "off" }, dimmer: { state: "off", brightness: 0 } },
    capabilities: [{ action: "turn_on" }, { action: "set_brightness", parameters: [{ name: "brightness", type: "number", required: true }] }],
    ...extra
  };
}

test("simulator loads virtual devices and marks internal source", async () => {
  await withConfig(
    {
      virtual: {
        enabled: true,
        devices: [baseDevice()]
      }
    },
    async (configPath) => {
      const store = new InMemorySimulatorStore();
      const simulator = new DeviceSimulator({
        store,
        logger: new Logger("error"),
        deviceConfigPath: configPath,
        enabled: true
      });

      await simulator.start();
      const saved = await store.get("sim_light_lr");
      assert.ok(saved);
      assert.equal(saved.bindings?.vendor_extra?.[SIMULATOR_SOURCE_FLAG], true);
      assert.equal(simulator.runtimeById.size, 1);
    }
  );
});

test("simulator applies default transitions for turn_on and set_brightness", async () => {
  await withConfig(
    {
      virtual: {
        enabled: true,
        devices: [baseDevice()]
      }
    },
    async (configPath) => {
      const store = new InMemorySimulatorStore();
      const simulator = new DeviceSimulator({
        store,
        logger: new Logger("error"),
        deviceConfigPath: configPath,
        enabled: true,
        random: () => 0.9
      });

      await simulator.start();
      const handledOn = await simulator.handleAction({ id: "sim_light_lr", action: "turn_on", params: {} });
      assert.equal(handledOn, true);

      const afterOn = await store.get("sim_light_lr");
      assert.equal(afterOn.traits?.switch?.state, "on");

      const handledBrightness = await simulator.handleAction({
        id: "sim_light_lr",
        action: "set_brightness",
        params: { brightness: 66 }
      });
      assert.equal(handledBrightness, true);

      const afterBrightness = await store.get("sim_light_lr");
      assert.equal(afterBrightness.traits?.dimmer?.brightness, 66);
      assert.equal(afterBrightness.traits?.dimmer?.state, "on");
      assert.equal(store.actionResults.length, 2);
      assert.equal(store.actionResults[1].status, "ok");
    }
  );
});

test("simulator supports failure injection", async () => {
  await withConfig(
    {
      virtual: {
        enabled: true,
        devices: [
          baseDevice({
            simulation: {
              failure_rate: 1
            }
          })
        ]
      }
    },
    async (configPath) => {
      const store = new InMemorySimulatorStore();
      const simulator = new DeviceSimulator({
        store,
        logger: new Logger("error"),
        deviceConfigPath: configPath,
        enabled: true,
        random: () => 0.2
      });

      await simulator.start();
      await simulator.handleAction({ id: "sim_light_lr", action: "turn_on", params: {} });

      const saved = await store.get("sim_light_lr");
      assert.equal(saved.traits?.switch?.state, "off");
      assert.equal(store.actionResults.length, 1);
      assert.equal(store.actionResults[0].status, "error");
      assert.equal(store.actionResults[0].reason, "simulated_failure");
    }
  );
});

test("simulator ignores actions for non-virtual device ids", async () => {
  await withConfig(
    {
      virtual: {
        enabled: true,
        devices: [baseDevice()]
      }
    },
    async (configPath) => {
      const store = new InMemorySimulatorStore();
      const simulator = new DeviceSimulator({
        store,
        logger: new Logger("error"),
        deviceConfigPath: configPath,
        enabled: true
      });

      await simulator.start();
      const handled = await simulator.handleAction({ id: "other_device", action: "turn_on", params: {} });
      assert.equal(handled, false);
      assert.equal(store.actionResults.length, 0);
    }
  );
});
