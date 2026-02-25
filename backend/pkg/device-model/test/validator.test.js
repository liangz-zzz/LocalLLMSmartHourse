import test from "node:test";
import assert from "node:assert/strict";
import sample from "../examples/living_room_plug.json" with { type: "json" };
import { validateDevice, validateDevices } from "../src/validator.js";

test("validateDevice accepts valid sample", () => {
  const result = validateDevice(sample);
  assert.equal(result.success, true);
});

test("validateDevice rejects invalid payload", () => {
  const invalid = { ...sample, id: "" };
  const result = validateDevice(invalid);
  assert.equal(result.success, false);
  assert.ok(result.errors?.id);
});

test("validateDevices aggregates results", () => {
  const mixed = [sample, { ...sample, id: "" }];
  const result = validateDevices(mixed);
  assert.equal(result.success, false);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[1].success, false);
});

test("validateDevice accepts voice_control binding", () => {
  const voiceEnabled = {
    ...sample,
    protocol: "virtual",
    bindings: {
      voice_control: {
        transport: "local_tts",
        priority: "prefer",
        audio_output: "living_room_speaker",
        preferred_mics: ["mic_living_room"],
        wake: { utterances: ["小度小度"], retries: 1, gap_ms: 500 },
        ack: { keywords: ["我在", "请说"], timeout_ms: 4000, listen_window_ms: 3000 },
        actions: {
          turn_on: { utterances: ["打开{device_name}"], risk: "low" },
          set_brightness: {
            utterances: ["把{device_name}亮度调到{value}%"],
            slot_schema: {
              value: { type: "number", minimum: 1, maximum: 100, required: true }
            },
            risk: "medium"
          }
        }
      }
    }
  };

  const result = validateDevice(voiceEnabled);
  assert.equal(result.success, true);
});
