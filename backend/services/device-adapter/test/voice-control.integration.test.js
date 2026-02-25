import test from "node:test";
import assert from "node:assert/strict";

import { DeviceAdapter } from "../src/adapter.js";
import { Logger } from "../src/log.js";

function makeDevice({ id = "voice_fan", room = "living_room", bindingOverrides = {} } = {}) {
  return {
    id,
    name: "客厅风扇",
    protocol: "virtual",
    placement: {
      room,
      coordinates: { x: 1, y: 1, z: 1 }
    },
    bindings: {
      voice_control: {
        transport: "local_tts",
        priority: "prefer",
        wake: {
          utterances: ["小度小度"],
          retries: 0,
          gap_ms: 0
        },
        ack: {
          keywords: ["我在", "请说"],
          timeout_ms: 1000,
          listen_window_ms: 1000
        },
        actions: {
          turn_on: {
            utterances: ["打开{device_name}"],
            risk: "low"
          }
        },
        ...bindingOverrides
      }
    },
    traits: {},
    capabilities: [{ action: "turn_on" }]
  };
}

function makeStore(device) {
  const results = [];
  return {
    results,
    async get(id) {
      return id === device.id ? device : undefined;
    },
    async publishActionResult(result) {
      results.push(result);
    }
  };
}

test("voice action picks nearest mic and executes command when ack keyword matches", async () => {
  const device = makeDevice();
  const store = makeStore(device);
  const speakCalls = [];
  const listenCalls = [];
  const runtime = {
    async speak(input) {
      speakCalls.push(input);
    },
    async listen(input) {
      listenCalls.push(input);
      return { text: "我在，请说", timedOut: false };
    }
  };

  const adapter = new DeviceAdapter({
    mode: "offline",
    mqttUrl: "mqtt://invalid",
    store,
    logger: new Logger("error"),
    mockDataDir: "",
    actionTransport: "voice",
    voiceRuntime: runtime,
    voiceControlConfig: {
      defaults: { ack_keywords: ["我在"] },
      mic_selection: { mode: "nearest_static", max_distance: 50 },
      mics: [
        {
          id: "mic_bedroom",
          enabled: true,
          input_device: "bedroom-array",
          placement: { room: "bedroom", coordinates: { x: 20, y: 20, z: 1 } }
        },
        {
          id: "mic_living_room",
          enabled: true,
          input_device: "living-array",
          placement: { room: "living_room", coordinates: { x: 2, y: 2, z: 1 } }
        }
      ]
    }
  });

  await adapter.handleAction({ id: device.id, action: "turn_on", params: {} });

  assert.equal(store.results.length, 1);
  assert.equal(store.results[0].status, "ok");
  assert.equal(store.results[0].transport, "voice");
  assert.equal(store.results[0].details.selected_mic_id, "mic_living_room");
  assert.equal(speakCalls.length, 2);
  assert.equal(speakCalls[0].phase, "wake");
  assert.equal(speakCalls[1].phase, "command");
  assert.equal(listenCalls.length, 1);
  assert.equal(listenCalls[0].mic.id, "mic_living_room");
});

test("voice action blocks command when ack keywords do not match and returns diagnostic reason", async () => {
  const device = makeDevice();
  const store = makeStore(device);
  const speakCalls = [];
  const runtime = {
    async speak(input) {
      speakCalls.push(input);
    },
    async listen() {
      return { text: "好的，收到", timedOut: false };
    }
  };

  const adapter = new DeviceAdapter({
    mode: "offline",
    mqttUrl: "mqtt://invalid",
    store,
    logger: new Logger("error"),
    mockDataDir: "",
    actionTransport: "voice",
    voiceRuntime: runtime,
    voiceControlConfig: {
      defaults: { ack_keywords: ["我在", "请说"] },
      mic_selection: { mode: "nearest_static" },
      mics: [{ id: "mic_living_room", enabled: true, placement: { room: "living_room" } }]
    }
  });

  await adapter.handleAction({ id: device.id, action: "turn_on", params: {} });

  assert.equal(store.results.length, 1);
  assert.equal(store.results[0].status, "error");
  assert.equal(store.results[0].transport, "voice");
  assert.equal(store.results[0].errorCode, "ack_keyword_not_matched");
  assert.match(store.results[0].reason, /设备响应内容/);
  assert.match(store.results[0].reason, /关键词未匹配/);
  assert.match(store.results[0].reason, /我在/);
  assert.equal(store.results[0].details.detected_response, "好的，收到");
  assert.deepEqual(store.results[0].details.expected_keywords, ["我在", "请说"]);
  assert.equal(speakCalls.length, 1, "should only speak wake phrase when ack mismatches");
});

test("voice action fails when nearest microphone exceeds max distance", async () => {
  const device = makeDevice({
    room: "kitchen",
    bindingOverrides: {
      ack: undefined
    }
  });
  const store = makeStore(device);
  const runtime = {
    async speak() {
      throw new Error("speak should not be called");
    },
    async listen() {
      throw new Error("listen should not be called");
    }
  };

  const adapter = new DeviceAdapter({
    mode: "offline",
    mqttUrl: "mqtt://invalid",
    store,
    logger: new Logger("error"),
    mockDataDir: "",
    actionTransport: "voice",
    voiceRuntime: runtime,
    voiceControlConfig: {
      defaults: { ack_keywords: ["我在"] },
      mic_selection: { mode: "nearest_static", max_distance: 1 },
      mics: [
        {
          id: "mic_far",
          enabled: true,
          placement: { room: "living_room", coordinates: { x: 20, y: 20, z: 1 } }
        }
      ]
    }
  });

  await adapter.handleAction({ id: device.id, action: "turn_on", params: {} });

  assert.equal(store.results.length, 1);
  assert.equal(store.results[0].status, "error");
  assert.equal(store.results[0].errorCode, "max_distance_exceeded");
  assert.match(store.results[0].reason, /最大距离限制/);
});
