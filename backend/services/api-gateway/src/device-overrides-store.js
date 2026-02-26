import fs from "node:fs/promises";
import path from "node:path";

const RESERVED_TOP_LEVEL_KEYS = new Set(["devices", "voice_control", "voice", "virtual", "$schema", "version"]);

export class DeviceOverridesStoreError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    if (extra && typeof extra === "object") Object.assign(this, extra);
  }
}

export class DeviceOverridesStore {
  constructor({ deviceOverridesPath, logger }) {
    this.deviceOverridesPath = deviceOverridesPath || "./devices.config.json";
    this.logger = logger;
  }

  resolvePath() {
    const raw = String(this.deviceOverridesPath || "").trim() || "./devices.config.json";
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }

  async list() {
    const { devices: list } = await this.loadEnvelope();
    validateOverrideList(list);
    return list;
  }

  async get(id) {
    const list = await this.list();
    return list.find((d) => d.id === id);
  }

  async upsert(id, patch) {
    const list = await this.list();
    const deviceId = String(id || "").trim();
    if (!deviceId) throw new DeviceOverridesStoreError("invalid_device_override", "device override id is required");

    const next = [...list];
    const index = next.findIndex((d) => d?.id === deviceId);
    const existing = index >= 0 ? next[index] : null;
    const merged = mergeOverride(existing, { ...(patch || {}), id: deviceId });

    if (index >= 0) next[index] = merged;
    else next.push(merged);

    validateOverrideList(next);
    await this.save(next);
    return merged;
  }

  async delete(id) {
    const list = await this.list();
    const deviceId = String(id || "").trim();
    const index = list.findIndex((d) => d?.id === deviceId);
    if (index < 0) throw new DeviceOverridesStoreError("device_override_not_found", `device override ${deviceId} not found`);
    const next = list.filter((d) => d?.id !== deviceId);
    await this.save(next);
    return { removed: deviceId };
  }

  async load() {
    const { devices } = await this.loadEnvelope();
    return devices;
  }

  async loadEnvelope() {
    const resolved = this.resolvePath();
    try {
      const raw = await fs.readFile(resolved, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeOverrideEnvelope(parsed);
    } catch (err) {
      if (err?.code === "ENOENT") return { devices: [], envelope: {} };
      throw new DeviceOverridesStoreError("device_overrides_store_read_failed", err?.message || "failed to read device overrides file");
    }
  }

  async save(list) {
    const resolved = this.resolvePath();
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${resolved}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { envelope } = await this.loadEnvelope();
    const payload = JSON.stringify({ ...(envelope || {}), devices: list }, null, 2);
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, resolved);
  }
}

function normalizeOverrideEnvelope(parsed) {
  if (Array.isArray(parsed)) return { devices: parsed, envelope: {} };
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.devices)) {
      const { devices: _devices, ...rest } = parsed;
      return { devices: parsed.devices, envelope: rest };
    }
    const devices = Object.entries(parsed)
      .filter(([id]) => !RESERVED_TOP_LEVEL_KEYS.has(id))
      .map(([id, value]) => ({ id, ...(value || {}) }));
    const envelope = Object.fromEntries(Object.entries(parsed).filter(([key]) => RESERVED_TOP_LEVEL_KEYS.has(key) && key !== "devices"));
    return { devices, envelope };
  }
  return { devices: [], envelope: {} };
}

function validateOverrideList(list) {
  if (!Array.isArray(list)) throw new DeviceOverridesStoreError("invalid_device_override", "device overrides must be an array");
  const errors = [];
  const ids = new Set();
  list.forEach((entry, idx) => {
    const prefix = `devices[${idx}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    const id = String(entry.id || "").trim();
    if (!id) {
      errors.push(`${prefix}.id is required`);
      return;
    }
    if (ids.has(id)) errors.push(`${prefix}.id duplicate: ${id}`);
    ids.add(id);
    if (entry.placement !== undefined && !isPlainObject(entry.placement)) errors.push(`${prefix}.placement must be an object`);
    if (entry.semantics !== undefined && !isPlainObject(entry.semantics)) errors.push(`${prefix}.semantics must be an object`);
    if (entry.capabilities !== undefined && !Array.isArray(entry.capabilities)) errors.push(`${prefix}.capabilities must be an array`);
  });
  if (errors.length) {
    throw new DeviceOverridesStoreError("invalid_device_override", errors.join("; "), { details: errors });
  }
}

function mergeOverride(existing, patch) {
  const out = { ...(existing || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "placement" && isPlainObject(v)) {
      out.placement = { ...(out.placement || {}), ...v };
      continue;
    }
    if (k === "bindings" && isPlainObject(v)) {
      out.bindings = deepMerge(out.bindings || {}, v);
      continue;
    }
    if (k === "semantics" && isPlainObject(v)) {
      out.semantics = mergeSemantics(out.semantics, v);
      continue;
    }
    out[k] = v;
  }
  out.id = String(patch?.id || out.id || "").trim();
  return out;
}

function mergeSemantics(a, b) {
  const out = { ...(a || {}), ...(b || {}) };
  if (Array.isArray(b?.tags)) out.tags = b.tags;
  if (Array.isArray(b?.aliases)) out.aliases = b.aliases;
  if (Array.isArray(b?.preferred_scenes)) out.preferred_scenes = b.preferred_scenes;
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

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}
