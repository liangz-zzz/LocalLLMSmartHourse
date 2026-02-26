import fs from "node:fs/promises";
import path from "node:path";

export const SIMULATOR_SOURCE_FLAG = "__simulator_source";
const SIMULATION_ACTION_KEYS = new Set(["traits", "from_params", "latency_ms", "failure_rate"]);

export async function loadSimulatorConfig({ filePath, logger, enabledByEnv = true, defaultLatencyMs = 120, defaultFailureRate = 0 }) {
  const resolved = resolveConfigPath(filePath);

  if (!enabledByEnv) {
    logger?.info?.("Device simulator disabled by env", { path: resolved });
    return { enabled: false, resolved, defaults: { latencyMs: defaultLatencyMs, failureRate: defaultFailureRate }, devices: new Map() };
  }

  let parsed;
  try {
    const raw = await fs.readFile(resolved, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    if (err?.code === "ENOENT") {
      logger?.warn?.("Simulator config not found, simulator disabled", { path: resolved });
      return { enabled: false, resolved, defaults: { latencyMs: defaultLatencyMs, failureRate: defaultFailureRate }, devices: new Map() };
    }
    throw err;
  }

  const virtual = isPlainObject(parsed?.virtual) ? parsed.virtual : null;
  if (!virtual) {
    logger?.info?.("No virtual section in config, simulator disabled", { path: resolved });
    return { enabled: false, resolved, defaults: { latencyMs: defaultLatencyMs, failureRate: defaultFailureRate }, devices: new Map() };
  }

  const enabled = parseBoolean(virtual.enabled, true);
  if (!enabled) {
    logger?.info?.("Virtual section disabled", { path: resolved });
    return { enabled: false, resolved, defaults: { latencyMs: defaultLatencyMs, failureRate: defaultFailureRate }, devices: new Map() };
  }

  const defaults = {
    latencyMs: normalizeLatency(virtual?.defaults?.latency_ms, defaultLatencyMs),
    failureRate: normalizeFailureRate(virtual?.defaults?.failure_rate, defaultFailureRate)
  };

  const list = Array.isArray(virtual.devices) ? virtual.devices : [];
  const devices = new Map();

  for (const [index, item] of list.entries()) {
    const runtime = normalizeRuntimeDevice({ item, index, defaults, logger });
    if (!runtime) continue;
    if (devices.has(runtime.id)) {
      logger?.warn?.("Duplicate virtual device id ignored", { id: runtime.id, index });
      continue;
    }
    devices.set(runtime.id, runtime);
  }

  return { enabled: true, resolved, defaults, devices };
}

function normalizeRuntimeDevice({ item, index, defaults, logger }) {
  if (!isPlainObject(item)) {
    logger?.warn?.("Invalid virtual device entry, object expected", { index });
    return null;
  }

  const id = String(item.id || "").trim();
  if (!id) {
    logger?.warn?.("Invalid virtual device entry, id required", { index });
    return null;
  }

  const placement = isPlainObject(item.placement) ? clone(item.placement) : {};
  if (!placement.room) {
    placement.room = "unknown_room";
    if (!placement.description) {
      placement.description = "virtual device placement placeholder";
    }
  }

  const bindings = isPlainObject(item.bindings) ? clone(item.bindings) : {};
  bindings.vendor_extra = isPlainObject(bindings.vendor_extra) ? bindings.vendor_extra : {};
  bindings.vendor_extra[SIMULATOR_SOURCE_FLAG] = true;

  const simulation = isPlainObject(item.simulation) ? item.simulation : {};
  const latencyMs = normalizeLatency(simulation.latency_ms, defaults.latencyMs);
  const failureRate = normalizeFailureRate(simulation.failure_rate, defaults.failureRate);

  const baseTraits = isPlainObject(item.traits) ? clone(item.traits) : {};
  const initialTraits = isPlainObject(simulation.initial_traits) ? deepMerge(baseTraits, clone(simulation.initial_traits)) : baseTraits;

  const template = {
    id,
    name: String(item.name || id),
    placement,
    protocol: String(item.protocol || "virtual"),
    bindings,
    traits: initialTraits,
    capabilities: normalizeCapabilities(item.capabilities),
    semantics: isPlainObject(item.semantics) ? clone(item.semantics) : undefined
  };

  if (isPlainObject(item.telemetry)) {
    template.telemetry = clone(item.telemetry);
  }
  if (!template.semantics) {
    delete template.semantics;
  }

  return {
    id,
    template,
    simulation: {
      latencyMs,
      failureRate,
      transitions: normalizeTransitions({ id, raw: simulation.transitions, logger })
    }
  };
}

function normalizeCapabilities(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (!isPlainObject(entry)) return null;
      const action = String(entry.action || "").trim();
      if (!action) return null;
      const out = { ...entry, action };
      if (Array.isArray(entry.parameters)) {
        out.parameters = entry.parameters.filter((p) => isPlainObject(p) && String(p.name || "").trim() && String(p.type || "").trim());
      }
      return out;
    })
    .filter(Boolean);
}

function normalizeTransitions({ id, raw, logger }) {
  const map = new Map();
  if (!isPlainObject(raw)) return map;

  for (const [actionName, actionSpec] of Object.entries(raw)) {
    const action = String(actionName || "").trim();
    if (!action || !isPlainObject(actionSpec)) continue;

    const hasKnownKeys = Object.keys(actionSpec).some((key) => SIMULATION_ACTION_KEYS.has(key));
    const traitsPatch = hasKnownKeys
      ? isPlainObject(actionSpec.traits)
        ? clone(actionSpec.traits)
        : {}
      : clone(actionSpec);

    const fromParams = [];
    if (Array.isArray(actionSpec.from_params)) {
      for (const entry of actionSpec.from_params) {
        if (!isPlainObject(entry)) continue;
        const param = String(entry.param || "").trim();
        const traitPath = String(entry.trait_path || "").trim();
        if (!param || !traitPath) continue;
        fromParams.push({ param, traitPath });
      }
    }

    const latencyMs =
      actionSpec.latency_ms === undefined ? undefined : normalizeLatency(actionSpec.latency_ms, undefined, { id, action, logger });
    const failureRate =
      actionSpec.failure_rate === undefined
        ? undefined
        : normalizeFailureRate(actionSpec.failure_rate, undefined, { id, action, logger });

    map.set(action, {
      traitsPatch,
      fromParams,
      latencyMs,
      failureRate
    });
  }

  return map;
}

function resolveConfigPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function normalizeLatency(value, fallback = 0, ctx) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    if (ctx?.logger) {
      ctx.logger.warn?.("Invalid virtual latency_ms, fallback applied", { id: ctx.id, action: ctx.action, value, fallback });
    }
    return fallback;
  }
  return Math.floor(n);
}

function normalizeFailureRate(value, fallback = 0, ctx) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    if (ctx?.logger) {
      ctx.logger.warn?.("Invalid virtual failure_rate, fallback applied", { id: ctx.id, action: ctx.action, value, fallback });
    }
    return fallback;
  }
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function deepMerge(base, patch) {
  const out = clone(base) || {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = clone(value);
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
