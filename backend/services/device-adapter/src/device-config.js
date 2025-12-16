import fs from "fs/promises";
import path from "path";

export async function loadDeviceOverrides(filePath, logger) {
  if (!filePath) return new Map();
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  try {
    const raw = await fs.readFile(resolved, "utf8");
    const parsed = JSON.parse(raw);
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
    return Object.entries(parsed).map(([id, value]) => ({ id, ...(value || {}) }));
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

