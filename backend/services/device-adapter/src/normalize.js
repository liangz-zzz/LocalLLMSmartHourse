function toSwitchState(state) {
  if (!state) return "off";
  const lower = String(state).toLowerCase();
  return lower === "on" ? "on" : "off";
}

export function normalizeZigbee2Mqtt({ device, state, placement }) {
  const friendly = device?.friendly_name || device?.ieee_address || "unknown_device";
  const id = friendly;

  const power = typeof state?.power === "number" ? state.power : undefined;
  const energy = typeof state?.energy === "number" ? state.energy : undefined;

  return {
    id,
    name: friendly.replace(/_/g, " "),
    placement: placement || {
      room: "unknown_room",
      description: "placeholder placement; provide real room/zone when available"
    },
    protocol: "zigbee",
    bindings: {
      zigbee2mqtt: {
        topic: `zigbee2mqtt/${friendly}`,
        friendly_name: device?.friendly_name,
        ieee_address: device?.ieee_address
      },
      ha: {
        entity_id: `switch.${friendly}`
      }
    },
    traits: {
      switch: {
        state: toSwitchState(state?.state),
        power_w: power,
        energy_kwh: energy
      },
      telemetry: {
        last_seen: state?.last_seen,
        linkquality: state?.linkquality
      }
    },
    capabilities: [
      { action: "turn_on", description: "通断插座电源" },
      { action: "turn_off", description: "关闭插座电源" }
    ],
    semantics: {
      tags: ["plug", "power", "zigbee"],
      vendor: device?.definition?.vendor,
      model: device?.definition?.model,
      description: device?.definition?.description
    }
  };
}
