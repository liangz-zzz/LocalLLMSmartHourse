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

