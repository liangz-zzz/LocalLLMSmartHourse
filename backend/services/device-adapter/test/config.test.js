import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("loadConfig defaults storage=redis for ha mode", () => {
  const original = { ...process.env };
  try {
    process.env.MODE = "ha";
    delete process.env.STORAGE;
    const cfg = loadConfig();
    assert.equal(cfg.mode, "ha");
    assert.equal(cfg.storage, "redis");
  } finally {
    process.env = original;
  }
});

test("loadConfig parses voice env settings", () => {
  const original = { ...process.env };
  try {
    process.env.VOICE_TTS_COMMAND = "echo \"$VOICE_TEXT\"";
    process.env.VOICE_STT_COMMAND = "echo 我在";
    process.env.VOICE_DEFAULT_ACK_KEYWORDS = "我在,请说";
    process.env.VOICE_MIC_MAX_DISTANCE = "8.5";
    process.env.VOICE_COMMAND_TIMEOUT_MS = "9000";

    const cfg = loadConfig();
    assert.equal(cfg.voiceTtsCommand, "echo \"$VOICE_TEXT\"");
    assert.equal(cfg.voiceSttCommand, "echo 我在");
    assert.deepEqual(cfg.voiceAckKeywords, ["我在", "请说"]);
    assert.equal(cfg.voiceMicMaxDistance, 8.5);
    assert.equal(cfg.voiceCommandTimeoutMs, 9000);
  } finally {
    process.env = original;
  }
});
