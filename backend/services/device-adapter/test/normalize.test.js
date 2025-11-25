import test from "node:test";
import assert from "node:assert/strict";
import { normalizeZigbee2Mqtt } from "../src/normalize.js";

const mockDevice = {
  ieee_address: "0x00158d00045abcde",
  friendly_name: "living_room_plug",
  definition: { vendor: "Xiaomi", model: "ZNCZ04LM", description: "Mi power plug" }
};

const mockState = {
  state: "ON",
  power: 12.4,
  energy: 1.23,
  linkquality: 120,
  last_seen: "2024-05-01T12:00:00Z"
};

test("normalizeZigbee2Mqtt maps device and state", () => {
  const normalized = normalizeZigbee2Mqtt({ device: mockDevice, state: mockState });

  assert.equal(normalized.id, "living_room_plug");
  assert.equal(normalized.traits.switch.state, "on");
  assert.equal(normalized.traits.switch.power_w, 12.4);
  assert.equal(normalized.traits.telemetry.linkquality, 120);
  assert.ok(normalized.capabilities.find((c) => c.action === "turn_on"));
});
