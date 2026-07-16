import fs from "node:fs/promises";
import path from "node:path";

const RESERVED_TOP_LEVEL_KEYS = new Set(["devices", "voice_control", "voice", "virtual", "virtual_models", "$schema", "version"]);

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

  async listVoiceMics() {
    const { envelope } = await this.loadEnvelope();
    const { voiceEnvelope } = resolveVoiceEnvelope(envelope);
    validateVoiceMicList(voiceEnvelope.mics);
    return voiceEnvelope.mics;
  }

  async getVoiceMic(id) {
    const micId = String(id || "").trim();
    if (!micId) return null;
    const list = await this.listVoiceMics();
    return list.find((item) => item.id === micId) || null;
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

  async upsertVoiceMic(id, patch) {
    const micId = String(id || "").trim();
    if (!micId) throw new DeviceOverridesStoreError("invalid_device_override", "voice mic id is required");

    const { devices, envelope } = await this.loadEnvelope();
    const { key, voiceEnvelope } = resolveVoiceEnvelope(envelope);
    const next = [...voiceEnvelope.mics];
    const index = next.findIndex((item) => item?.id === micId);
    const existing = index >= 0 ? next[index] : null;
    const merged = mergeVoiceMic(existing, { ...(patch || {}), id: micId });

    if (index >= 0) next[index] = merged;
    else next.push(merged);

    validateVoiceMicList(next);
    const nextEnvelope = { ...(envelope || {}), [key]: { ...(voiceEnvelope.meta || {}), mics: next } };
    await this.saveEnvelope({ devices, envelope: nextEnvelope });
    return merged;
  }

  async reconcileFloorplanCoordinates(coordinateMap) {
    const coordinates = coordinateMap instanceof Map ? coordinateMap : new Map();
    const { devices, envelope } = await this.loadEnvelope();
    const nextDevices = reconcileCoordinateEntries(devices, coordinates, { addMissing: true });
    const { key, voiceEnvelope } = resolveVoiceEnvelope(envelope);
    const nextMics = reconcileCoordinateEntries(voiceEnvelope.mics, coordinates, { addMissing: false });

    validateOverrideList(nextDevices);
    validateVoiceMicList(nextMics);
    const nextEnvelope = {
      ...(envelope || {}),
      [key]: { ...(voiceEnvelope.meta || {}), mics: nextMics }
    };
    await this.saveEnvelope({ devices: nextDevices, envelope: nextEnvelope });
    return { devices: nextDevices.length, voiceMics: nextMics.length, coordinates: coordinates.size };
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
    const { envelope } = await this.loadEnvelope();
    await this.saveEnvelope({ devices: list, envelope });
  }

  async saveEnvelope({ devices, envelope }) {
    const resolved = this.resolvePath();
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${resolved}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = JSON.stringify({ ...(envelope || {}), devices }, null, 2);
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
    validateCoordinates(entry.placement?.coordinates, `${prefix}.placement.coordinates`, errors);
    if (entry.semantics !== undefined && !isPlainObject(entry.semantics)) errors.push(`${prefix}.semantics must be an object`);
    if (entry.capabilities !== undefined && !Array.isArray(entry.capabilities)) errors.push(`${prefix}.capabilities must be an array`);
  });
  if (errors.length) {
    throw new DeviceOverridesStoreError("invalid_device_override", errors.join("; "), { details: errors });
  }
}

function validateVoiceMicList(list) {
  if (!Array.isArray(list)) throw new DeviceOverridesStoreError("invalid_device_override", "voice_control.mics must be an array");
  const ids = new Set();
  const errors = [];
  list.forEach((entry, idx) => {
    const prefix = `voice_control.mics[${idx}]`;
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
    validateCoordinates(entry.placement?.coordinates, `${prefix}.placement.coordinates`, errors);
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

function mergeVoiceMic(existing, patch) {
  const out = { ...(existing || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "placement" && isPlainObject(v)) {
      out.placement = deepMerge(out.placement || {}, v);
      continue;
    }
    out[k] = v;
  }
  out.id = String(patch?.id || out.id || "").trim();
  return out;
}

function reconcileCoordinateEntries(entries, coordinates, { addMissing }) {
  const next = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = String(entry?.id || "").trim();
    if (!id) {
      next.push(entry);
      continue;
    }
    seen.add(id);
    const coordinate = coordinates.get(id);
    if (coordinate) {
      next.push({
        ...entry,
        placement: { ...(entry.placement || {}), coordinates: coordinate }
      });
      continue;
    }
    if (entry?.placement?.coordinates?.source === "floorplan") {
      const placement = { ...(entry.placement || {}) };
      delete placement.coordinates;
      const cleaned = { ...entry };
      if (Object.keys(placement).length) cleaned.placement = placement;
      else delete cleaned.placement;
      if (Object.keys(cleaned).some((key) => key !== "id")) next.push(cleaned);
      continue;
    }
    next.push(entry);
  }

  if (addMissing) {
    for (const [id, coordinate] of coordinates.entries()) {
      if (seen.has(id)) continue;
      next.push({ id, placement: { coordinates: coordinate } });
    }
  }
  return next;
}

function validateCoordinates(value, prefix, errors) {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const key of ["x", "y", "z", "lat", "lon"]) {
    if (value[key] !== undefined && !Number.isFinite(value[key])) errors.push(`${prefix}.${key} must be a number`);
  }
  if (value.source === "floorplan") {
    for (const key of ["x", "y", "z"]) {
      if (!Number.isFinite(value[key])) errors.push(`${prefix}.${key} is required for floorplan coordinates`);
    }
    if (value.unit !== "m") errors.push(`${prefix}.unit must be m for floorplan coordinates`);
    if (value.frame !== "floorplan_image") errors.push(`${prefix}.frame must be floorplan_image for floorplan coordinates`);
    if (typeof value.floorplanId !== "string" || !value.floorplanId.trim()) {
      errors.push(`${prefix}.floorplanId is required for floorplan coordinates`);
    }
  }
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

function resolveVoiceEnvelope(envelope) {
  if (isPlainObject(envelope?.voice_control)) {
    return {
      key: "voice_control",
      voiceEnvelope: {
        meta: { ...envelope.voice_control },
        mics: normalizeVoiceMicList(envelope.voice_control.mics)
      }
    };
  }
  if (isPlainObject(envelope?.voice)) {
    return {
      key: "voice",
      voiceEnvelope: {
        meta: { ...envelope.voice },
        mics: normalizeVoiceMicList(envelope.voice.mics)
      }
    };
  }
  return { key: "voice_control", voiceEnvelope: { meta: {}, mics: [] } };
}

function normalizeVoiceMicList(value) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (!isPlainObject(item)) continue;
    const id = String(item.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...item, id });
  }
  return out;
}
