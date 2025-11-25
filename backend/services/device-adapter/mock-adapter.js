#!/usr/bin/env node
/**
 * Offline mock adapter: normalizes sample zigbee2mqtt payloads into the unified device model.
 * Run: node backend/services/device-adapter/mock-adapter.js [--out path]
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "mock-data", "zigbee2mqtt");
const deviceMeta = readJson(path.join(root, "device.json"));
const deviceState = readJson(path.join(root, "state.json"));

const normalized = normalizeDevice(deviceMeta, deviceState);

const outIndex = process.argv.indexOf("--out");
if (outIndex !== -1 && process.argv[outIndex + 1]) {
  const outPath = path.resolve(process.argv[outIndex + 1]);
  fs.writeFileSync(outPath, JSON.stringify(normalized, null, 2));
  console.log(`Normalized device written to ${outPath}`);
} else {
  console.log(JSON.stringify(normalized, null, 2));
}

function normalizeDevice(meta, state) {
  const friendly = meta.friendly_name || meta.ieee_address;
  const powerState = (state.state || "").toLowerCase() === "on" ? "on" : "off";

  return {
    id: friendly || "unknown_device",
    name: friendly?.replace(/_/g, " ") || "Unknown device",
    placement: {
      room: "living_room",
      zone: "sofa_corner",
      mount: "wall",
      description: "Sample placement; replace with real context when available"
    },
    protocol: "zigbee",
    bindings: {
      zigbee2mqtt: {
        topic: `zigbee2mqtt/${friendly}`,
        friendly_name: friendly,
        ieee_address: meta.ieee_address
      },
      ha: {
        entity_id: `switch.${friendly}`
      }
    },
    traits: {
      switch: {
        state: powerState,
        power_w: typeof state.power === "number" ? state.power : undefined,
        energy_kwh: typeof state.energy === "number" ? state.energy : undefined
      },
      telemetry: {
        last_seen: state.last_seen,
        linkquality: state.linkquality
      }
    },
    capabilities: [
      { action: "turn_on", description: "通断插座电源" },
      { action: "turn_off", description: "关闭插座电源" }
    ],
    semantics: {
      tags: ["plug", "power", "zigbee"],
      vendor: meta.definition?.vendor,
      model: meta.definition?.model,
      description: meta.definition?.description
    }
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err);
    process.exit(1);
  }
}
