import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { loadDeviceOverrides, loadVoiceControlConfig } from "../src/device-config.js";

test("device config separates device overrides and voice_control section", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-config-voice-"));
  const filePath = path.join(tmpDir, "devices.config.json");
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        kettle_plug: {
          name: "烧水壶插座"
        },
        voice_control: {
          defaults: { ack_keywords: ["我在", "请说"] },
          mics: [{ id: "mic_living_room", enabled: true, placement: { room: "living_room" } }]
        },
        virtual: {
          enabled: true,
          devices: [{ id: "sim_light", name: "模拟灯", placement: { room: "living_room" }, capabilities: [{ action: "turn_on" }] }]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const overrides = await loadDeviceOverrides(filePath);
  assert.equal(overrides.size, 1);
  assert.equal(overrides.has("voice_control"), false);
  assert.equal(overrides.has("virtual"), false);
  assert.equal(overrides.get("kettle_plug")?.name, "烧水壶插座");

  const voiceConfig = await loadVoiceControlConfig(filePath);
  assert.deepEqual(voiceConfig.defaults.ack_keywords, ["我在", "请说"]);
  assert.equal(voiceConfig.mics.length, 1);
  assert.equal(voiceConfig.mics[0].id, "mic_living_room");
});
