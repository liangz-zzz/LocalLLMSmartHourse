import test from "node:test";
import assert from "node:assert/strict";
import { DeviceIdentityResolver } from "../src/device-identity.js";

test("stable identity does not change when a Zigbee device is renamed or moved", () => {
  const resolver = new DeviceIdentityResolver();
  const before = resolver.enrichDevice({
    id: "zigbee:0x00158d00045abcde",
    name: "旧开关名称",
    protocol: "zigbee",
    placement: { room: "unknown_room" },
    bindings: {
      zigbee2mqtt: {
        friendly_name: "old_switch_name",
        topic: "zigbee2mqtt/old_switch_name",
        ieee_address: "0x00158D00045ABCDE"
      }
    }
  });
  const after = resolver.enrichDevice({
    id: "zigbee:0x00158d00045abcde",
    name: "客厅开关",
    protocol: "zigbee",
    placement: { room: "living_room" },
    bindings: {
      zigbee2mqtt: {
        friendly_name: "客厅开关",
        topic: "zigbee2mqtt/客厅开关",
        ieee_address: "0x00158d00045abcde"
      }
    }
  });

  assert.equal(before.identity.stableKey, after.identity.stableKey);
});
