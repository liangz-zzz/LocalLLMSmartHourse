function toSwitchState(state) {
  if (!state) return "off";
  const lower = String(state).toLowerCase();
  return lower === "on" ? "on" : "off";
}

export function normalizeZigbeeIeeeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

export function buildZigbeeDeviceId(device) {
  const ieeeAddress = normalizeZigbeeIeeeAddress(device?.ieee_address);
  if (ieeeAddress) return `zigbee:${ieeeAddress}`;

  const friendlyName = String(device?.friendly_name || "unknown_device").trim();
  return `zigbee:${friendlyName}`;
}

export function buildZigbeeChannelId(device, endpoint) {
  return `${buildZigbeeDeviceId(device)}:${String(endpoint || "").trim()}`;
}

export function extractZigbeeRelayChannels(device) {
  const exposes = Array.isArray(device?.definition?.exposes) ? device.definition.exposes : [];
  const operationModes = new Map();
  for (const expose of exposes) {
    if (expose?.name !== "operation_mode" || !expose?.endpoint || !expose?.property) continue;
    operationModes.set(String(expose.endpoint), String(expose.property));
  }

  const channels = [];
  for (const expose of exposes) {
    if (expose?.type !== "switch" || !expose?.endpoint) continue;
    const stateFeature = (Array.isArray(expose.features) ? expose.features : []).find(
      (feature) => feature?.name === "state" && feature?.property
    );
    if (!stateFeature) continue;
    const endpoint = String(expose.endpoint);
    channels.push({
      endpoint,
      stateProperty: String(stateFeature.property),
      operationModeProperty: operationModes.get(endpoint)
    });
  }
  return channels;
}

export function normalizeZigbee2MqttDevices({ device, state, placement }) {
  const channels = extractZigbeeRelayChannels(device);
  if (channels.length <= 1) return [normalizeZigbee2Mqtt({ device, state, placement })];

  const friendly = device?.friendly_name || device?.ieee_address || "unknown_device";
  const parentId = buildZigbeeDeviceId(device);
  const resolvedPlacement = placement || defaultPlacement();
  const commonBinding = {
    topic: `zigbee2mqtt/${friendly}`,
    friendly_name: device?.friendly_name,
    ieee_address: device?.ieee_address
  };
  const childIds = channels.map((channel) => buildZigbeeChannelId(device, channel.endpoint));
  const telemetry = buildTelemetry(state);
  const parent = {
    id: parentId,
    name: friendly.replace(/_/g, " "),
    placement: resolvedPlacement,
    protocol: "zigbee",
    bindings: { zigbee2mqtt: commonBinding },
    traits: { telemetry },
    capabilities: [],
    composition: { role: "panel", childIds },
    semantics: {
      tags: ["switch_panel", "zigbee"],
      vendor: device?.definition?.vendor,
      model: device?.definition?.model,
      description: device?.definition?.description
    }
  };

  const children = channels.map((channel) => {
    const operationMode = normalizeOperationMode(state?.[channel.operationModeProperty]);
    const switchTrait = {
      state: toSwitchState(state?.[channel.stateProperty])
    };
    if (operationMode) switchTrait.operation_mode = operationMode;
    return {
      id: buildZigbeeChannelId(device, channel.endpoint),
      name: `${friendly.replace(/_/g, " ")} · ${humanizeEndpoint(channel.endpoint)}`,
      placement: resolvedPlacement,
      protocol: "zigbee",
      bindings: {
        zigbee2mqtt: {
          ...commonBinding,
          endpoint: channel.endpoint,
          state_property: channel.stateProperty,
          ...(channel.operationModeProperty ? { operation_mode_property: channel.operationModeProperty } : {})
        }
      },
      traits: { switch: switchTrait, telemetry },
      capabilities: [
        { action: "turn_on", description: `打开${humanizeEndpoint(channel.endpoint)}` },
        { action: "turn_off", description: `关闭${humanizeEndpoint(channel.endpoint)}` },
        { action: "toggle", description: `切换${humanizeEndpoint(channel.endpoint)}` },
        ...(channel.operationModeProperty
          ? [
              {
                action: "set_operation_mode",
                description: "设置物理按键与继电器的工作模式",
                parameters: [
                  {
                    name: "mode",
                    type: "enum",
                    enum: ["control_relay", "decoupled"],
                    required: true
                  }
                ]
              }
            ]
          : [])
      ],
      composition: { role: "relay_channel", parentId, endpoint: channel.endpoint },
      semantics: {
        tags: ["light", "relay_channel", "zigbee"],
        aliases: [`${friendly}${channel.endpoint}`, `${humanizeEndpoint(channel.endpoint)}灯路`],
        vendor: device?.definition?.vendor,
        model: device?.definition?.model,
        description: `${friendly} ${channel.endpoint} 硬接线灯路`
      }
    };
  });

  return [parent, ...children];
}

export function parseZigbeeButtonEvent(device, state) {
  const raw = String(state?.action || "").trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/^(single|double)_(.+)$/);
  if (match) {
    return { type: "button", gesture: match[1], selector: match[2], raw };
  }
  const channels = extractZigbeeRelayChannels(device);
  if ((raw === "single" || raw === "double") && channels.length === 1) {
    return { type: "button", gesture: raw, selector: channels[0].endpoint, raw };
  }
  return null;
}

export function normalizeZigbee2Mqtt({ device, state, placement }) {
  const friendly = device?.friendly_name || device?.ieee_address || "unknown_device";
  const id = buildZigbeeDeviceId(device);

  const power = typeof state?.power === "number" ? state.power : undefined;
  const energy = typeof state?.energy === "number" ? state.energy : undefined;

  return {
    id,
    name: friendly.replace(/_/g, " "),
    placement: placement || defaultPlacement(),
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
      { action: "turn_off", description: "关闭插座电源" },
      {
        action: "set_brightness",
        parameters: [{ name: "brightness", type: "number", minimum: 0, maximum: 100, required: true }],
        description: "设置亮度（如设备支持）"
      },
      {
        action: "set_cover_position",
        parameters: [{ name: "position", type: "number", minimum: 0, maximum: 100, required: true }],
        description: "设置窗帘位置"
      },
      {
        action: "set_temperature",
        parameters: [{ name: "temperature", type: "number", minimum: 5, maximum: 35, required: true }],
        description: "设置目标温度"
      },
      {
        action: "set_hvac_mode",
        parameters: [{ name: "mode", type: "enum", enum: ["auto", "heat", "cool", "fan_only", "off"], required: true }],
        description: "切换空调模式"
      }
    ],
    semantics: {
      tags: ["plug", "power", "zigbee"],
      vendor: device?.definition?.vendor,
      model: device?.definition?.model,
      description: device?.definition?.description
    }
  };
}

function buildTelemetry(state) {
  return {
    last_seen: state?.last_seen,
    linkquality: state?.linkquality
  };
}

function defaultPlacement() {
  return {
    room: "unknown_room",
    description: "placeholder placement; provide real room/zone when available"
  };
}

function normalizeOperationMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "control_relay" || mode === "decoupled" ? mode : undefined;
}

function humanizeEndpoint(endpoint) {
  const labels = { left: "左路", center: "中路", right: "右路" };
  return labels[endpoint] || String(endpoint || "通道");
}
