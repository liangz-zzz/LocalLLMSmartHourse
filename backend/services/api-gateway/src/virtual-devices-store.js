import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_DEFAULTS = Object.freeze({
  latency_ms: 120,
  failure_rate: 0
});

export class VirtualDevicesStoreError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    if (extra && typeof extra === "object") Object.assign(this, extra);
  }
}

export class VirtualDevicesStore {
  constructor({ deviceConfigPath, logger }) {
    this.deviceConfigPath = deviceConfigPath || "./devices.config.json";
    this.logger = logger;
  }

  resolvePath() {
    const raw = String(this.deviceConfigPath || "").trim() || "./devices.config.json";
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }

  async getConfig() {
    const root = await this.loadRoot();
    return normalizeVirtualConfig(root.virtual);
  }

  async saveConfig(patch) {
    const root = await this.loadRoot();
    const current = normalizeVirtualConfig(root.virtual);

    const next = normalizeVirtualConfig({
      enabled: patch?.enabled ?? current.enabled,
      defaults: isPlainObject(patch?.defaults) ? { ...current.defaults, ...patch.defaults } : current.defaults,
      devices: Array.isArray(patch?.devices) ? patch.devices : current.devices
    });

    root.virtual = toPersistedVirtual(next);
    await this.saveRoot(root);
    return next;
  }

  async upsert(id, patch) {
    const deviceId = String(id || "").trim();
    if (!deviceId) {
      throw new VirtualDevicesStoreError("invalid_virtual_config", "virtual device id is required");
    }

    const root = await this.loadRoot();
    const current = normalizeVirtualConfig(root.virtual);

    const nextDevices = [...current.devices];
    const index = nextDevices.findIndex((item) => item.id === deviceId);
    const merged = mergeVirtualDevice(index >= 0 ? nextDevices[index] : null, {
      ...(patch || {}),
      id: deviceId
    });

    if (index >= 0) nextDevices[index] = merged;
    else nextDevices.push(merged);

    const next = normalizeVirtualConfig({
      enabled: current.enabled,
      defaults: current.defaults,
      devices: nextDevices
    });
    root.virtual = toPersistedVirtual(next);
    await this.saveRoot(root);
    return next.devices.find((item) => item.id === deviceId);
  }

  async delete(id) {
    const deviceId = String(id || "").trim();
    if (!deviceId) {
      throw new VirtualDevicesStoreError("invalid_virtual_config", "virtual device id is required");
    }

    const root = await this.loadRoot();
    const current = normalizeVirtualConfig(root.virtual);
    const nextDevices = current.devices.filter((item) => item.id !== deviceId);
    if (nextDevices.length === current.devices.length) {
      throw new VirtualDevicesStoreError("virtual_device_not_found", `virtual device ${deviceId} not found`);
    }

    const next = normalizeVirtualConfig({
      enabled: current.enabled,
      defaults: current.defaults,
      devices: nextDevices
    });
    root.virtual = toPersistedVirtual(next);
    await this.saveRoot(root);
    return { removed: deviceId };
  }

  async loadRoot() {
    const resolved = this.resolvePath();
    try {
      const raw = await fs.readFile(resolved, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeRootConfig(parsed);
    } catch (err) {
      if (err?.code === "ENOENT") return {};
      throw new VirtualDevicesStoreError("virtual_devices_store_read_failed", err?.message || "failed to read devices config");
    }
  }

  async saveRoot(root) {
    const resolved = this.resolvePath();
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${resolved}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = JSON.stringify(root, null, 2);
    try {
      await fs.writeFile(tmp, payload, "utf8");
      await fs.rename(tmp, resolved);
    } catch (err) {
      throw new VirtualDevicesStoreError("virtual_devices_store_write_failed", err?.message || "failed to write devices config");
    }
  }
}

function normalizeRootConfig(parsed) {
  if (Array.isArray(parsed)) {
    return { devices: parsed };
  }
  if (isPlainObject(parsed)) {
    return clone(parsed);
  }
  return {};
}

function toPersistedVirtual(config) {
  return {
    enabled: config.enabled,
    defaults: { ...config.defaults },
    devices: config.devices.map((item) => clone(item))
  };
}

function normalizeVirtualConfig(raw) {
  const errors = [];

  const virtual = isPlainObject(raw) ? raw : {};
  const defaults = isPlainObject(virtual.defaults) ? virtual.defaults : {};

  const enabled = parseBoolean(virtual.enabled, false);
  const normalizedDefaults = {
    latency_ms: normalizeLatency(defaults.latency_ms, DEFAULT_DEFAULTS.latency_ms),
    failure_rate: normalizeFailureRate(defaults.failure_rate, DEFAULT_DEFAULTS.failure_rate)
  };

  const list = Array.isArray(virtual.devices) ? virtual.devices : [];
  const devices = [];
  const ids = new Set();

  list.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      errors.push(`virtual.devices[${index}] must be an object`);
      return;
    }

    const id = String(entry.id || "").trim();
    if (!id) {
      errors.push(`virtual.devices[${index}].id is required`);
      return;
    }
    if (ids.has(id)) {
      errors.push(`virtual.devices[${index}].id duplicate: ${id}`);
      return;
    }
    ids.add(id);

    const next = clone(entry);
    next.id = id;
    next.name = String(next.name || id).trim() || id;
    next.protocol = String(next.protocol || "virtual").trim() || "virtual";

    if (next.placement !== undefined && !isPlainObject(next.placement)) {
      errors.push(`virtual.devices[${index}].placement must be an object`);
      return;
    }
    next.placement = isPlainObject(next.placement) ? next.placement : {};

    if (next.bindings !== undefined && !isPlainObject(next.bindings)) {
      errors.push(`virtual.devices[${index}].bindings must be an object`);
      return;
    }
    next.bindings = isPlainObject(next.bindings) ? next.bindings : {};

    if (next.traits !== undefined && !isPlainObject(next.traits)) {
      errors.push(`virtual.devices[${index}].traits must be an object`);
      return;
    }
    next.traits = isPlainObject(next.traits) ? next.traits : {};

    if (next.semantics !== undefined && !isPlainObject(next.semantics)) {
      errors.push(`virtual.devices[${index}].semantics must be an object`);
      return;
    }

    if (next.capabilities !== undefined && !Array.isArray(next.capabilities)) {
      errors.push(`virtual.devices[${index}].capabilities must be an array`);
      return;
    }
    next.capabilities = Array.isArray(next.capabilities)
      ? next.capabilities
          .filter((item) => isPlainObject(item) && String(item.action || "").trim())
          .map((item) => ({
            ...item,
            action: String(item.action || "").trim()
          }))
      : [];

    if (next.simulation !== undefined && !isPlainObject(next.simulation)) {
      errors.push(`virtual.devices[${index}].simulation must be an object`);
      return;
    }

    if (isPlainObject(next.simulation)) {
      const normalizedSimulation = { ...next.simulation };
      if (Object.prototype.hasOwnProperty.call(normalizedSimulation, "latency_ms")) {
        normalizedSimulation.latency_ms = normalizeLatency(normalizedSimulation.latency_ms, normalizedDefaults.latency_ms);
      }
      if (Object.prototype.hasOwnProperty.call(normalizedSimulation, "failure_rate")) {
        normalizedSimulation.failure_rate = normalizeFailureRate(normalizedSimulation.failure_rate, normalizedDefaults.failure_rate);
      }
      next.simulation = normalizedSimulation;
    }

    devices.push(next);
  });

  if (errors.length) {
    throw new VirtualDevicesStoreError("invalid_virtual_config", errors.join("; "), { details: errors });
  }

  return {
    enabled,
    defaults: normalizedDefaults,
    devices
  };
}

function mergeVirtualDevice(existing, patch) {
  const out = clone(existing || {});
  for (const [key, value] of Object.entries(patch || {})) {
    if (["placement", "bindings", "traits", "simulation", "semantics"].includes(key) && isPlainObject(value)) {
      out[key] = deepMerge(isPlainObject(out[key]) ? out[key] : {}, value);
      continue;
    }
    out[key] = clone(value);
  }

  out.id = String(out.id || "").trim();
  if (!out.name) out.name = out.id;
  if (!out.protocol) out.protocol = "virtual";
  if (!isPlainObject(out.placement)) out.placement = {};
  if (!isPlainObject(out.bindings)) out.bindings = {};
  if (!isPlainObject(out.traits)) out.traits = {};
  if (!Array.isArray(out.capabilities)) out.capabilities = [];
  return out;
}

function normalizeLatency(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function normalizeFailureRate(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function deepMerge(a, b) {
  const out = clone(a || {});
  for (const [k, v] of Object.entries(b || {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = clone(v);
    }
  }
  return out;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

