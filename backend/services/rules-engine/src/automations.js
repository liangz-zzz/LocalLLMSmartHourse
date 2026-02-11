import fs from "node:fs/promises";
import path from "node:path";

const OPERATORS = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);

export class AutomationConfigError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function resolveAutomationsPath({ automationsPath, configDir }) {
  const raw = String(automationsPath || "").trim();
  const dir = String(configDir || "").trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  if (dir) return path.join(dir, "automations.json");
  return path.resolve(process.cwd(), "automations.json");
}

export async function loadAutomationsFile(resolvedPath) {
  try {
    const raw = await fs.readFile(resolvedPath, "utf8");
    const parsed = JSON.parse(raw);
    const list = normalizeAutomationList(parsed);
    validateAutomationList(list);
    return { ok: true, items: list };
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, items: [] };
    if (err instanceof AutomationConfigError) {
      return { ok: false, error: err.code, message: err.message, details: err.details || [] };
    }
    return { ok: false, error: "automations_load_failed", message: err?.message || String(err) };
  }
}

export function normalizeAutomationList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.automations)) return parsed.automations;
    return Object.entries(parsed).map(([id, value]) => ({ id, ...(value || {}) }));
  }
  return [];
}

export function validateAutomationList(list) {
  if (!Array.isArray(list)) throw new AutomationConfigError("invalid_automations", "automations must be an array");
  const errors = [];
  const ids = new Set();

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const prefix = `automations[${i}]`;
    if (!isPlainObject(a)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const id = String(a.id || "").trim();
    if (!id) {
      errors.push(`${prefix}.id is required`);
    } else if (ids.has(id)) {
      errors.push(`${prefix}.id duplicate: ${id}`);
    } else {
      ids.add(id);
    }

    if (!isPlainObject(a.trigger)) {
      errors.push(`${prefix}.trigger is required`);
    } else {
      validateTrigger(a.trigger, `${prefix}.trigger`, errors);
    }

    if (a.when !== undefined) {
      validateCondition(a.when, `${prefix}.when`, errors);
    }

    if (a.forMs !== undefined && (!Number.isFinite(a.forMs) || a.forMs < 0)) {
      errors.push(`${prefix}.forMs must be a non-negative number`);
    }
    if (a.cooldownMs !== undefined && (!Number.isFinite(a.cooldownMs) || a.cooldownMs < 0)) {
      errors.push(`${prefix}.cooldownMs must be a non-negative number`);
    }

    if (!Array.isArray(a.then) || a.then.length === 0) {
      errors.push(`${prefix}.then must be a non-empty array`);
    } else {
      for (let j = 0; j < a.then.length; j++) {
        validateAction(a.then[j], `${prefix}.then[${j}]`, errors);
      }
    }
  }

  if (errors.length) {
    throw new AutomationConfigError("invalid_automations", errors.join("; "), errors);
  }
}

function validateTrigger(trigger, prefix, errors) {
  const type = String(trigger.type || "").trim();
  if (!type) {
    errors.push(`${prefix}.type is required`);
    return;
  }
  if (type === "device") {
    if (trigger.deviceId !== undefined && !isStringOrStringArray(trigger.deviceId)) {
      errors.push(`${prefix}.deviceId must be string or string[]`);
    }
    if (trigger.changed === true && (typeof trigger.traitPath !== "string" || !trigger.traitPath.trim())) {
      errors.push(`${prefix}.traitPath is required when changed=true`);
    }
    if (trigger.traitPath !== undefined && (typeof trigger.traitPath !== "string" || !trigger.traitPath.trim())) {
      errors.push(`${prefix}.traitPath must be string`);
    }
    if (trigger.operator !== undefined && (typeof trigger.operator !== "string" || !OPERATORS.has(trigger.operator))) {
      errors.push(`${prefix}.operator must be one of ${Array.from(OPERATORS).join(",")}`);
    }
    if (trigger.operator !== undefined && !Object.prototype.hasOwnProperty.call(trigger, "value")) {
      errors.push(`${prefix}.value is required when operator is set`);
    }
    if (Object.prototype.hasOwnProperty.call(trigger, "value") && trigger.operator === undefined) {
      // value implies operator=eq by default; allow omit operator
    }
  } else if (type === "time") {
    const at = trigger.at;
    if (!isStringOrStringArray(at) || (Array.isArray(at) && at.length === 0)) {
      errors.push(`${prefix}.at must be time string "HH:MM" or string[]`);
    } else {
      const times = Array.isArray(at) ? at : [at];
      for (const t of times) {
        if (!isTimeOfDay(t)) errors.push(`${prefix}.at invalid time: ${t}`);
      }
    }
  } else if (type === "interval") {
    if (!Number.isFinite(trigger.everyMs) || trigger.everyMs <= 0) {
      errors.push(`${prefix}.everyMs must be a positive number`);
    }
  } else {
    errors.push(`${prefix}.type unsupported: ${type}`);
  }
}

function validateAction(action, prefix, errors) {
  if (!isPlainObject(action)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  const type = String(action.type || "").trim();
  if (type === "scene") {
    if (typeof action.sceneId !== "string" || !action.sceneId.trim()) {
      errors.push(`${prefix}.sceneId is required`);
    }
    return;
  }
  if (type === "device") {
    if (typeof action.deviceId !== "string" || !action.deviceId.trim()) {
      errors.push(`${prefix}.deviceId is required`);
    }
    if (typeof action.action !== "string" || !action.action.trim()) {
      errors.push(`${prefix}.action is required`);
    }
    if (action.params !== undefined && !isPlainObject(action.params)) {
      errors.push(`${prefix}.params must be an object`);
    }
    if (action.wait_for !== undefined) {
      validateWaitFor(action.wait_for, `${prefix}.wait_for`, errors);
    }
    return;
  }
  errors.push(`${prefix}.type must be "scene" or "device"`);
}

function validateWaitFor(waitFor, prefix, errors) {
  if (!isPlainObject(waitFor)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (typeof waitFor.traitPath !== "string" || !waitFor.traitPath.trim()) {
    errors.push(`${prefix}.traitPath is required`);
  }
  if (typeof waitFor.operator !== "string" || !OPERATORS.has(waitFor.operator)) {
    errors.push(`${prefix}.operator must be one of ${Array.from(OPERATORS).join(",")}`);
  }
  if (!Object.prototype.hasOwnProperty.call(waitFor, "value")) {
    errors.push(`${prefix}.value is required`);
  }
  if (!Number.isFinite(waitFor.timeoutMs) || waitFor.timeoutMs <= 0) {
    errors.push(`${prefix}.timeoutMs must be a positive number`);
  }
  if (waitFor.pollMs !== undefined && (!Number.isFinite(waitFor.pollMs) || waitFor.pollMs <= 0)) {
    errors.push(`${prefix}.pollMs must be a positive number`);
  }
  if (waitFor.on_timeout !== undefined && waitFor.on_timeout !== "abort") {
    errors.push(`${prefix}.on_timeout must be "abort"`);
  }
}

function validateCondition(cond, prefix, errors) {
  if (!isPlainObject(cond)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (Array.isArray(cond.all)) {
    for (let i = 0; i < cond.all.length; i++) validateCondition(cond.all[i], `${prefix}.all[${i}]`, errors);
    return;
  }
  if (Array.isArray(cond.any)) {
    for (let i = 0; i < cond.any.length; i++) validateCondition(cond.any[i], `${prefix}.any[${i}]`, errors);
    return;
  }
  if (cond.not !== undefined) {
    validateCondition(cond.not, `${prefix}.not`, errors);
    return;
  }
  if (isPlainObject(cond.time)) {
    const after = cond.time.after;
    const before = cond.time.before;
    if (after !== undefined && !isTimeOfDay(after)) errors.push(`${prefix}.time.after must be "HH:MM"`);
    if (before !== undefined && !isTimeOfDay(before)) errors.push(`${prefix}.time.before must be "HH:MM"`);
    if (after === undefined && before === undefined) errors.push(`${prefix}.time must define after and/or before`);
    return;
  }

  // atomic: deviceId + traitPath + operator/value (or equals)
  if (typeof cond.deviceId !== "string" || !cond.deviceId.trim()) {
    errors.push(`${prefix}.deviceId is required`);
  }
  if (typeof cond.traitPath !== "string" || !cond.traitPath.trim()) {
    errors.push(`${prefix}.traitPath is required`);
  }

  if (cond.equals !== undefined) {
    // ok
    return;
  }

  const operator = cond.operator !== undefined ? String(cond.operator) : "eq";
  if (!OPERATORS.has(operator)) errors.push(`${prefix}.operator must be one of ${Array.from(OPERATORS).join(",")}`);
  if (!Object.prototype.hasOwnProperty.call(cond, "value")) {
    errors.push(`${prefix}.value is required`);
  }
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function isStringOrStringArray(v) {
  if (typeof v === "string") return true;
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim());
}

export function isTimeOfDay(value) {
  const raw = String(value || "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return Number.isInteger(hh) && Number.isInteger(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}
