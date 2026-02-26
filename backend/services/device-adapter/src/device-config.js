import fs from "fs/promises";
import path from "path";

const RESERVED_TOP_LEVEL_KEYS = new Set(["devices", "voice_control", "voice", "virtual", "$schema", "version"]);

export async function loadDeviceOverrides(filePath, logger) {
  if (!filePath) return new Map();
  try {
    const { parsed, resolved } = await readConfigFile(filePath);
    const list = normalizeOverrideList(parsed);
    const map = new Map();
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      if (!entry.id) continue;
      map.set(String(entry.id), entry);
    }
    logger?.info?.("Loaded device overrides", { path: resolved, count: map.size });
    return map;
  } catch (err) {
    if (err?.code === "ENOENT") {
      logger?.info?.("No device overrides file found, skipping", { path: resolved });
      return new Map();
    }
    logger?.warn?.("Failed to load device overrides, skipping", { path: resolved, error: err?.message || String(err) });
    return new Map();
  }
}

export async function loadVoiceControlConfig(filePath, logger) {
  if (!filePath) return emptyVoiceControlConfig();
  try {
    const { parsed, resolved } = await readConfigFile(filePath);
    const raw = parsed?.voice_control || parsed?.voice || {};
    const config = normalizeVoiceControlConfig(raw);
    logger?.info?.("Loaded voice control config", {
      path: resolved,
      microphones: config.mics.length,
      hasDefaultAckKeywords: config.defaults.ack_keywords.length > 0
    });
    return config;
  } catch (err) {
    if (err?.code === "ENOENT") {
      logger?.info?.("No voice control config found, using defaults", { path: resolveConfigPath(filePath) });
      return emptyVoiceControlConfig();
    }
    logger?.warn?.("Failed to load voice control config, using defaults", {
      path: resolveConfigPath(filePath),
      error: err?.message || String(err)
    });
    return emptyVoiceControlConfig();
  }
}

export function applyDeviceOverrides({ base, existing, override }) {
  let merged = { ...base };
  if (existing && typeof existing === "object") {
    merged = mergeDevice(merged, existing);
  }
  if (override && typeof override === "object") {
    merged = mergeDevice(merged, override);
  }
  return merged;
}

function normalizeOverrideList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.devices)) return parsed.devices;
    return Object.entries(parsed)
      .filter(([id]) => !RESERVED_TOP_LEVEL_KEYS.has(id))
      .map(([id, value]) => ({ id, ...(value || {}) }));
  }
  return [];
}

function mergeDevice(target, source) {
  const out = { ...target };

  if (source.name) out.name = source.name;
  if (source.protocol) out.protocol = source.protocol;

  if (source.placement && typeof source.placement === "object") {
    out.placement = { ...(out.placement || {}), ...source.placement };
  }

  if (source.bindings && typeof source.bindings === "object") {
    out.bindings = deepMerge(out.bindings || {}, source.bindings);
  }

  if (source.semantics && typeof source.semantics === "object") {
    out.semantics = mergeSemantics(out.semantics, source.semantics);
  }

  if (Array.isArray(source.capabilities)) {
    out.capabilities = source.capabilities;
  }

  return out;
}

function mergeSemantics(a, b) {
  const out = { ...(a || {}), ...(b || {}) };
  out.tags = uniqStrings([...(a?.tags || []), ...(b?.tags || [])]);
  out.preferred_scenes = uniqStrings([...(a?.preferred_scenes || []), ...(b?.preferred_scenes || [])]);
  out.aliases = uniqStrings([...(a?.aliases || []), ...(b?.aliases || [])]);
  if (!out.tags.length) delete out.tags;
  if (!out.preferred_scenes.length) delete out.preferred_scenes;
  if (!out.aliases.length) delete out.aliases;
  return out;
}

function uniqStrings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    if (!item) continue;
    const s = String(item);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function deepMerge(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function readConfigFile(filePath) {
  const resolved = resolveConfigPath(filePath);
  const raw = await fs.readFile(resolved, "utf8");
  const parsed = JSON.parse(raw);
  return { parsed, resolved };
}

function resolveConfigPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function emptyVoiceControlConfig() {
  return {
    defaults: { ack_keywords: [] },
    mic_selection: { mode: "nearest_static" },
    mics: []
  };
}

function normalizeVoiceControlConfig(raw) {
  if (!raw || typeof raw !== "object") return emptyVoiceControlConfig();

  const defaultsRaw = raw.defaults && typeof raw.defaults === "object" ? raw.defaults : {};
  const micSelectionRaw = raw.mic_selection && typeof raw.mic_selection === "object" ? raw.mic_selection : {};
  const micList = Array.isArray(raw.mics) ? raw.mics : [];

  const mics = micList
    .map((item) => normalizeMic(item))
    .filter(Boolean);

  return {
    defaults: {
      ack_keywords: uniqStrings(defaultsRaw.ack_keywords || [])
    },
    mic_selection: {
      mode: String(micSelectionRaw.mode || "nearest_static"),
      max_distance: normalizeNumber(micSelectionRaw.max_distance)
    },
    mics
  };
}

function normalizeMic(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  const placement = item.placement && typeof item.placement === "object" ? item.placement : {};
  const coordinates = placement.coordinates && typeof placement.coordinates === "object" ? placement.coordinates : {};
  return {
    id,
    enabled: item.enabled !== false,
    input_device: item.input_device ?? null,
    placement: {
      room: String(placement.room || "").trim(),
      zone: placement.zone ? String(placement.zone) : undefined,
      coordinates: {
        x: normalizeNumber(coordinates.x),
        y: normalizeNumber(coordinates.y),
        z: normalizeNumber(coordinates.z),
        lat: normalizeNumber(coordinates.lat),
        lon: normalizeNumber(coordinates.lon)
      }
    }
  };
}

function normalizeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
