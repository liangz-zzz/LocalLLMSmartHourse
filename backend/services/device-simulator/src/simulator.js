import { loadSimulatorConfig, SIMULATOR_SOURCE_FLAG } from "./simulator-config.js";

export class DeviceSimulator {
  constructor({ store, logger, deviceConfigPath, enabled = true, defaultLatencyMs = 120, defaultFailureRate = 0, random = Math.random }) {
    this.store = store;
    this.logger = logger;
    this.deviceConfigPath = deviceConfigPath;
    this.enabled = enabled;
    this.defaultLatencyMs = defaultLatencyMs;
    this.defaultFailureRate = defaultFailureRate;
    this.random = typeof random === "function" ? random : Math.random;
    this.runtimeById = new Map();
    this.configResolvedPath = "";
  }

  async start() {
    const config = await loadSimulatorConfig({
      filePath: this.deviceConfigPath,
      logger: this.logger,
      enabledByEnv: this.enabled,
      defaultLatencyMs: this.defaultLatencyMs,
      defaultFailureRate: this.defaultFailureRate
    });

    this.configResolvedPath = config.resolved;

    if (!config.enabled || !config.devices.size) {
      this.runtimeById = new Map();
      this.logger?.info?.("Device simulator idle", {
        configPath: config.resolved,
        enabled: config.enabled,
        devices: config.devices.size
      });
      return;
    }

    const conflicts = [];
    for (const [id] of config.devices.entries()) {
      const existing = await this.store.get(id);
      if (!existing) continue;
      if (!isSimulatorDevice(existing)) {
        conflicts.push(id);
      }
    }

    if (conflicts.length) {
      throw new Error(`virtual device id conflict: ${conflicts.join(",")}`);
    }

    this.runtimeById = config.devices;

    for (const runtime of this.runtimeById.values()) {
      await this.store.upsert(clone(runtime.template));
      await this.store.publishStateSnapshot?.(runtime.template);
    }

    this.logger?.info?.("Device simulator loaded", {
      configPath: config.resolved,
      devices: this.runtimeById.size
    });
  }

  async stop() {
    // nothing to stop currently
  }

  async handleAction(action) {
    const deviceId = String(action?.id || "").trim();
    const actionName = String(action?.action || "").trim();
    if (!deviceId || !actionName) return false;

    const runtime = this.runtimeById.get(deviceId);
    if (!runtime) return false;

    const device = (await this.store.get(deviceId)) || clone(runtime.template);
    if (!device) return false;

    const capability = findCapability(device, actionName);
    if (!capability) {
      await this.publishActionResult({
        deviceId,
        actionName,
        status: "error",
        params: action?.params,
        reason: "action_not_supported"
      });
      return true;
    }

    const params = isPlainObject(action?.params) ? action.params : {};
    const validation = validateParams(capability, params);
    if (!validation.ok) {
      await this.publishActionResult({
        deviceId,
        actionName,
        status: "error",
        params,
        reason: validation.reason
      });
      return true;
    }

    const transition = runtime.simulation.transitions.get(actionName);
    const latencyMs = transition?.latencyMs ?? runtime.simulation.latencyMs ?? 0;
    const failureRate = transition?.failureRate ?? runtime.simulation.failureRate ?? 0;

    if (latencyMs > 0) {
      await sleep(latencyMs);
    }

    if (this.random() < failureRate) {
      await this.publishActionResult({
        deviceId,
        actionName,
        status: "error",
        params,
        reason: "simulated_failure",
        details: { failure_rate: failureRate }
      });
      return true;
    }

    const nextTraits = applyTransition({
      currentTraits: device.traits || {},
      action: actionName,
      params,
      transition
    });

    const nextDevice = {
      ...device,
      bindings: ensureSimulatorBindings(device.bindings),
      traits: nextTraits
    };

    await this.store.upsert(nextDevice);
    await this.store.publishStateSnapshot?.(nextDevice);
    await this.publishActionResult({
      deviceId,
      actionName,
      status: "ok",
      params,
      details: { latency_ms: latencyMs }
    });

    return true;
  }

  async publishActionResult({ deviceId, actionName, status, params, reason, details }) {
    const result = {
      id: `${deviceId}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      deviceId,
      action: actionName,
      status,
      transport: "simulator",
      reason,
      params,
      ts: Date.now()
    };
    if (details && isPlainObject(details)) {
      result.details = details;
    }
    await this.store.publishActionResult?.(result);
  }
}

function applyTransition({ currentTraits, action, params, transition }) {
  const next = clone(currentTraits) || {};

  applyDefaultTransition(next, action, params);

  if (transition?.traitsPatch && isPlainObject(transition.traitsPatch)) {
    mergeInto(next, transition.traitsPatch);
  }

  if (Array.isArray(transition?.fromParams)) {
    for (const mapping of transition.fromParams) {
      if (!Object.prototype.hasOwnProperty.call(params, mapping.param)) continue;
      setByPath(next, mapping.traitPath, params[mapping.param]);
    }
  }

  return next;
}

function applyDefaultTransition(traits, action, params) {
  if (action === "turn_on") {
    setByPath(traits, "switch.state", "on");
    if (isPlainObject(traits.dimmer)) {
      setByPath(traits, "dimmer.state", "on");
    }
    return;
  }

  if (action === "turn_off") {
    setByPath(traits, "switch.state", "off");
    if (isPlainObject(traits.dimmer)) {
      setByPath(traits, "dimmer.state", "off");
    }
    return;
  }

  if (action === "set_brightness") {
    const brightness = toNumber(params.brightness ?? params.level ?? params.value);
    if (brightness !== undefined) {
      setByPath(traits, "dimmer.brightness", clamp(brightness, 0, 100));
    }
    setByPath(traits, "dimmer.state", "on");
    setByPath(traits, "switch.state", "on");
    return;
  }

  if (action === "set_cover_position") {
    const position = toNumber(params.position);
    if (position !== undefined) {
      setByPath(traits, "cover.position_percent", clamp(position, 0, 100));
      setByPath(traits, "cover.state", "stopped");
    }
    return;
  }

  if (action === "set_cover_tilt") {
    const tilt = toNumber(params.tilt ?? params.tilt_percent);
    if (tilt !== undefined) {
      setByPath(traits, "cover.tilt_percent", clamp(tilt, 0, 100));
    }
    return;
  }

  if (action === "set_temperature") {
    const temperature = toNumber(params.temperature ?? params.target_temperature);
    if (temperature !== undefined) {
      setByPath(traits, "climate.target_temperature_c", temperature);
    }
    return;
  }

  if (action === "set_hvac_mode") {
    const mode = typeof params.mode === "string" ? params.mode : undefined;
    if (mode) {
      setByPath(traits, "climate.mode", mode);
    }
    return;
  }

  if (action === "set_fan_mode") {
    const fanMode = typeof params.fan_mode === "string" ? params.fan_mode : typeof params.mode === "string" ? params.mode : undefined;
    if (fanMode) {
      setByPath(traits, "climate.fan_mode", fanMode);
    }
    return;
  }

  if (action === "set_color_temp") {
    const kelvin = toNumber(params.kelvin ?? params.color_temp_kelvin);
    if (kelvin !== undefined) {
      setByPath(traits, "color_temp.kelvin", kelvin);
    }
  }
}

function validateParams(capability, params) {
  const specs = Array.isArray(capability?.parameters) ? capability.parameters : [];
  for (const spec of specs) {
    const name = String(spec?.name || "").trim();
    if (!name) continue;
    const value = params?.[name];

    if (value === undefined) {
      if (spec.required) return { ok: false, reason: `param ${name} is required` };
      continue;
    }

    const type = String(spec?.type || "").trim();
    if (type === "boolean" && typeof value !== "boolean") return { ok: false, reason: `param ${name} must be boolean` };
    if (type === "string" && typeof value !== "string") return { ok: false, reason: `param ${name} must be string` };
    if (type === "number") {
      if (typeof value !== "number") return { ok: false, reason: `param ${name} must be number` };
      if (spec.minimum !== undefined && value < spec.minimum) return { ok: false, reason: `param ${name} min ${spec.minimum}` };
      if (spec.maximum !== undefined && value > spec.maximum) return { ok: false, reason: `param ${name} max ${spec.maximum}` };
    }
    if (type === "enum") {
      if (!Array.isArray(spec.enum) || !spec.enum.includes(value)) return { ok: false, reason: `param ${name} must be in enum` };
    }
  }

  return { ok: true };
}

function findCapability(device, actionName) {
  if (!Array.isArray(device?.capabilities)) return null;
  return device.capabilities.find((item) => item?.action === actionName) || null;
}

function isSimulatorDevice(device) {
  return Boolean(device?.bindings?.vendor_extra?.[SIMULATOR_SOURCE_FLAG]);
}

function ensureSimulatorBindings(bindings) {
  const out = isPlainObject(bindings) ? clone(bindings) : {};
  out.vendor_extra = isPlainObject(out.vendor_extra) ? out.vendor_extra : {};
  out.vendor_extra[SIMULATOR_SOURCE_FLAG] = true;
  return out;
}

function mergeInto(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeInto(target[key], value);
    } else {
      target[key] = clone(value);
    }
  }
  return target;
}

function setByPath(target, path, value) {
  if (!path || typeof path !== "string") return;
  const segments = path.split(".").map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return;

  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (!isPlainObject(cursor[segment])) cursor[segment] = {};
    cursor = cursor[segment];
  }

  cursor[segments[segments.length - 1]] = clone(value);
}

function toNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export { SIMULATOR_SOURCE_FLAG };
