import test from "node:test";
import assert from "node:assert/strict";
import { normalizeZigbee2Mqtt, normalizeZigbee2MqttDevices, parseZigbeeButtonEvent } from "../src/normalize.js";

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

  assert.equal(normalized.id, "zigbee:0x00158d00045abcde");
  assert.equal(normalized.name, "living room plug");
  assert.equal(normalized.bindings.zigbee2mqtt.friendly_name, "living_room_plug");
  assert.equal(normalized.traits.switch.state, "on");
  assert.equal(normalized.traits.switch.power_w, 12.4);
  assert.equal(normalized.traits.telemetry.linkquality, 120);
  assert.ok(normalized.capabilities.find((c) => c.action === "turn_on"));
});

test("normalizeZigbee2MqttDevices expands an Aqara three-gang panel into addressable relay channels", () => {
  const device = aqaraPanel({
    model: "QBKG34LM",
    endpoints: ["left", "center", "right"]
  });
  const normalized = normalizeZigbee2MqttDevices({
    device,
    state: {
      state_left: "ON",
      state_center: "OFF",
      state_right: "ON",
      operation_mode_left: "control_relay",
      operation_mode_center: "decoupled",
      operation_mode_right: "control_relay",
      linkquality: 96
    },
    placement: { room: "living_room", zone: "entrance" }
  });

  assert.equal(normalized.length, 4);
  const [panel, left, center, right] = normalized;
  assert.equal(panel.id, "zigbee:0x00158d0000001234");
  assert.deepEqual(panel.composition, {
    role: "panel",
    childIds: [
      "zigbee:0x00158d0000001234:left",
      "zigbee:0x00158d0000001234:center",
      "zigbee:0x00158d0000001234:right"
    ]
  });
  assert.equal(left.composition.endpoint, "left");
  assert.equal(left.bindings.zigbee2mqtt.state_property, "state_left");
  assert.equal(left.bindings.zigbee2mqtt.operation_mode_property, "operation_mode_left");
  assert.equal(left.traits.switch.state, "on");
  assert.equal(center.traits.switch.operation_mode, "decoupled");
  assert.equal(right.placement, left.placement);
  assert.ok(left.capabilities.some((capability) => capability.action === "set_operation_mode"));
  assert.equal(panel.capabilities.length, 0);
});

test("parseZigbeeButtonEvent recognizes single, double and combo selectors", () => {
  const device = aqaraPanel({ model: "QBKG20LM", endpoints: ["left", "right"] });
  assert.deepEqual(parseZigbeeButtonEvent(device, { action: "single_left" }), {
    type: "button",
    gesture: "single",
    selector: "left",
    raw: "single_left"
  });
  assert.deepEqual(parseZigbeeButtonEvent(device, { action: "double_right" }), {
    type: "button",
    gesture: "double",
    selector: "right",
    raw: "double_right"
  });
  assert.deepEqual(parseZigbeeButtonEvent(device, { action: "single_both" })?.selector, "both");
  assert.equal(parseZigbeeButtonEvent(device, { action: "hold_left" }), null);
});

function aqaraPanel({ model, endpoints }) {
  return {
    ieee_address: "0x00158d0000001234",
    friendly_name: "living_room_panel",
    definition: {
      vendor: "Aqara",
      model,
      exposes: [
        ...endpoints.map((endpoint) => ({
          type: "switch",
          endpoint,
          features: [{ type: "binary", name: "state", property: `state_${endpoint}` }]
        })),
        ...endpoints.map((endpoint) => ({
          type: "enum",
          name: "operation_mode",
          endpoint,
          property: `operation_mode_${endpoint}`,
          values: ["control_relay", "decoupled"]
        }))
      ]
    }
  };
}
