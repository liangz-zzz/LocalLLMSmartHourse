const OPERATORS = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);

export class AutomationEngine {
  constructor({ publishAction, expandScene, logger, clock }) {
    this.publishAction = publishAction;
    this.expandScene = expandScene;
    this.logger = logger || console;
    this.clock = clock || defaultClock();

    this.automations = [];
    this.runtimeById = new Map();
    this.devices = new Map();
    this.waitersByDeviceId = new Map();
  }

  seedDevices(devices) {
    for (const d of devices || []) {
      if (d && typeof d === "object" && typeof d.id === "string" && d.id.trim()) {
        this.devices.set(d.id, d);
      }
    }
  }

  setAutomations(list) {
    const next = Array.isArray(list) ? list : [];
    const nextIds = new Set(next.map((a) => String(a?.id || "").trim()).filter(Boolean));

    // stop removed automations and keep cooldown state for existing ids
    for (const [id, state] of this.runtimeById.entries()) {
      if (!nextIds.has(id)) {
        this._stopAutomationState(state);
        this.runtimeById.delete(id);
      }
    }

    this.automations = next;

    // (re)schedule time/interval triggers
    for (const a of next) {
      const id = String(a?.id || "").trim();
      if (!id) continue;
      const state = this._state(id);
      // Apply config changes immediately: clear pending timers from previous config.
      this._cancelPending(state);
      this._setupNonDeviceTriggers(a, state);
    }
  }

  stop() {
    for (const state of this.runtimeById.values()) this._stopAutomationState(state);
    this.runtimeById.clear();
    this.automations = [];
    this.devices.clear();

    for (const waiters of this.waitersByDeviceId.values()) {
      for (const w of waiters) {
        if (w.timeoutHandle) this.clock.clearTimeout(w.timeoutHandle);
        w.reject?.(new Error("automation_engine_stopped"));
      }
    }
    this.waitersByDeviceId.clear();
  }

  handleDeviceUpdate(device) {
    if (!device || typeof device !== "object" || typeof device.id !== "string") return;
    const id = device.id;
    const prev = this.devices.get(id);
    this.devices.set(id, device);

    this._resolveWaitersForDevice(id);

    // Cancel pending executions if conditions no longer hold.
    for (const a of this.automations) {
      const aid = String(a?.id || "").trim();
      if (!aid) continue;
      const state = this._state(aid);
      if (!state.pendingHandle) continue;
      if (a?.enabled === false) {
        this._cancelPending(state);
        continue;
      }
      const ok = this._evaluateWhen(a);
      if (!ok) this._cancelPending(state);
    }

    // Check device triggers.
    for (const a of this.automations) {
      if (a?.enabled === false) continue;
      const aid = String(a?.id || "").trim();
      if (!aid) continue;
      const state = this._state(aid);
      if (!this._cooldownOk(a, state)) continue;
      if (!matchesDeviceTrigger(a?.trigger, { device, prev })) continue;
      this._maybeScheduleOrExecute(a, state, { kind: "device", deviceId: id });
    }
  }

  _state(id) {
    const existing = this.runtimeById.get(id);
    if (existing) return existing;
    const state = {
      id,
      pendingHandle: null,
      pendingSinceMs: null,
      cooldownUntilMs: null,
      executing: false,
      intervalHandle: null,
      timeHandle: null
    };
    this.runtimeById.set(id, state);
    return state;
  }

  _stopAutomationState(state) {
    if (!state) return;
    this._cancelPending(state);
    if (state.intervalHandle) this.clock.clearInterval(state.intervalHandle);
    if (state.timeHandle) this.clock.clearTimeout(state.timeHandle);
  }

  _setupNonDeviceTriggers(automation, state) {
    const t = automation?.trigger;
    const type = String(t?.type || "").trim();

    if (state.intervalHandle) {
      this.clock.clearInterval(state.intervalHandle);
      state.intervalHandle = null;
    }
    if (state.timeHandle) {
      this.clock.clearTimeout(state.timeHandle);
      state.timeHandle = null;
    }

    if (type === "interval") {
      const everyMs = Number(t.everyMs);
      if (!Number.isFinite(everyMs) || everyMs <= 0) return;
      state.intervalHandle = this.clock.setInterval(() => {
        if (automation?.enabled === false) return;
        if (!this._cooldownOk(automation, state)) return;
        this._maybeScheduleOrExecute(automation, state, { kind: "interval" });
      }, everyMs);
      return;
    }

    if (type === "time") {
      const times = Array.isArray(t.at) ? t.at : [t.at];
      const nextAtMs = computeNextTimeTriggerMs(this.clock.now(), times);
      if (!Number.isFinite(nextAtMs)) return;
      const delayMs = Math.max(0, nextAtMs - this.clock.now());
      state.timeHandle = this.clock.setTimeout(() => {
        state.timeHandle = null;
        if (automation?.enabled !== false && this._cooldownOk(automation, state)) {
          this._maybeScheduleOrExecute(automation, state, { kind: "time", at: new Date(this.clock.now()).toISOString() });
        }
        this._setupNonDeviceTriggers(automation, state);
      }, delayMs);
    }
  }

  _cooldownOk(automation, state) {
    const now = this.clock.now();
    const until = state.cooldownUntilMs;
    if (Number.isFinite(until) && now < until) return false;
    const cooldownMs = Number(automation?.cooldownMs || 0);
    if (cooldownMs <= 0) return true;
    return true;
  }

  _evaluateWhen(automation) {
    const when = automation?.when;
    if (!when) return true;
    try {
      return evaluateCondition(when, {
        nowMs: this.clock.now(),
        devices: this.devices
      });
    } catch (err) {
      this.logger?.warn?.("automation.when evaluation failed", { id: automation?.id, error: err?.message || String(err) });
      return false;
    }
  }

  _maybeScheduleOrExecute(automation, state, context) {
    if (!this._evaluateWhen(automation)) return;

    const forMs = Number(automation?.forMs || 0);
    if (Number.isFinite(forMs) && forMs > 0) {
      if (state.pendingHandle) return;
      state.pendingSinceMs = this.clock.now();
      state.pendingHandle = this.clock.setTimeout(async () => {
        state.pendingHandle = null;
        state.pendingSinceMs = null;
        if (automation?.enabled === false) return;
        if (!this._cooldownOk(automation, state)) return;
        if (!this._evaluateWhen(automation)) return;
        await this._executeAutomation(automation, state, { kind: "delayed", afterMs: forMs, ...context }).catch((err) => {
          this.logger?.warn?.("automation execute failed", { id: automation?.id, error: err?.message || String(err) });
        });
      }, forMs);
      return;
    }

    void this._executeAutomation(automation, state, context).catch((err) => {
      this.logger?.warn?.("automation execute failed", { id: automation?.id, error: err?.message || String(err) });
    });
  }

  _cancelPending(state) {
    if (!state?.pendingHandle) return;
    this.clock.clearTimeout(state.pendingHandle);
    state.pendingHandle = null;
    state.pendingSinceMs = null;
  }

  async _executeAutomation(automation, state, context) {
    if (state.executing) return;
    state.executing = true;
    const now = this.clock.now();
    const cooldownMs = Number(automation?.cooldownMs || 0);
    state.cooldownUntilMs = Number.isFinite(cooldownMs) && cooldownMs > 0 ? now + cooldownMs : null;
    this._cancelPending(state);

    const actor = `automation:${String(automation?.id || "unknown")}`;
    const runId = `auto_${String(automation?.id || "unknown")}_${now}`;
    this.logger?.info?.("automation.fired", { id: automation?.id, context, runId });

    try {
      for (let i = 0; i < (automation.then || []).length; i++) {
        const action = automation.then[i];
        if (!action || typeof action !== "object") continue;
        const type = String(action.type || "").trim();
        if (type === "scene") {
          const sceneId = String(action.sceneId || "").trim();
          if (!sceneId) continue;
          const expanded = await this.expandScene(sceneId);
          const steps = Array.isArray(expanded?.steps) ? expanded.steps : Array.isArray(expanded) ? expanded : [];
          let stepIndex = 0;
          for (const step of steps) {
            if (!step || typeof step !== "object" || step.type !== "device") continue;
            stepIndex += 1;
            const deviceId = String(step.deviceId || "").trim();
            const act = String(step.action || "").trim();
            if (!deviceId || !act) continue;
            const params = isPlainObject(step.params) ? step.params : {};
            await this.publishAction({
              id: deviceId,
              action: act,
              params,
              ts: this.clock.now(),
              actor,
              automationId: automation.id,
              runId,
              sceneId,
              stepIndex
            });
            if (isPlainObject(step.wait_for)) {
              await this._waitForCondition(deviceId, step.wait_for, { runId, sceneId, stepIndex });
            }
          }
          continue;
        }

        if (type === "device") {
          const deviceId = String(action.deviceId || "").trim();
          const act = String(action.action || "").trim();
          if (!deviceId || !act) continue;
          const params = isPlainObject(action.params) ? action.params : {};
          await this.publishAction({
            id: deviceId,
            action: act,
            params,
            ts: this.clock.now(),
            actor,
            automationId: automation.id,
            runId,
            stepIndex: i + 1
          });
          if (isPlainObject(action.wait_for)) {
            await this._waitForCondition(deviceId, action.wait_for, { runId, stepIndex: i + 1 });
          }
        }
      }
    } finally {
      state.executing = false;
    }
  }

  async _waitForCondition(deviceId, waitFor, context) {
    const traitPath = String(waitFor?.traitPath || "").trim();
    const operator = String(waitFor?.operator || "").trim();
    const timeoutMs = Number(waitFor?.timeoutMs);
    const expected = waitFor?.value;
    if (!traitPath || !OPERATORS.has(operator) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;

    const current = this.devices.get(deviceId);
    const currentValue = getPathValue(current, traitPath);
    if (compareValues(currentValue, operator, expected)) return;

    await new Promise((resolve, reject) => {
      const deadline = this.clock.now() + timeoutMs;
      const waiter = {
        deviceId,
        traitPath,
        operator,
        expected,
        deadline,
        resolve,
        reject,
        timeoutHandle: null
      };
      waiter.timeoutHandle = this.clock.setTimeout(() => {
        this._removeWaiter(waiter);
        const msg = buildWaitTimeoutMessage({ deviceId, waitFor, context });
        reject(new Error(msg));
      }, timeoutMs);

      const list = this.waitersByDeviceId.get(deviceId) || new Set();
      list.add(waiter);
      this.waitersByDeviceId.set(deviceId, list);
    });
  }

  _resolveWaitersForDevice(deviceId) {
    const waiters = this.waitersByDeviceId.get(deviceId);
    if (!waiters || !waiters.size) return;
    const device = this.devices.get(deviceId);
    for (const w of Array.from(waiters)) {
      if (!w) continue;
      const v = getPathValue(device, w.traitPath);
      if (compareValues(v, w.operator, w.expected)) {
        this._removeWaiter(w);
        w.resolve?.({ ok: true, value: v });
      }
    }
  }

  _removeWaiter(waiter) {
    const deviceId = waiter?.deviceId;
    if (!deviceId) return;
    const waiters = this.waitersByDeviceId.get(deviceId);
    if (waiters) {
      waiters.delete(waiter);
      if (!waiters.size) this.waitersByDeviceId.delete(deviceId);
    }
    if (waiter.timeoutHandle) this.clock.clearTimeout(waiter.timeoutHandle);
    waiter.timeoutHandle = null;
  }
}

function matchesDeviceTrigger(trigger, { device, prev }) {
  if (!trigger || typeof trigger !== "object") return false;
  const type = String(trigger.type || "").trim();
  if (type !== "device") return false;

  const deviceIds = normalizeStringArray(trigger.deviceId);
  if (deviceIds && deviceIds.length) {
    if (!deviceIds.includes(device.id)) return false;
  }

  const traitPath = typeof trigger.traitPath === "string" ? trigger.traitPath.trim() : "";
  const wantsChanged = trigger.changed === true;
  if (!traitPath) return !wantsChanged;

  const currentValue = getPathValue(device, traitPath);
  if (currentValue === undefined) return false;

  if (wantsChanged) {
    if (!prev) return false;
    const prevValue = getPathValue(prev, traitPath);
    if (prevValue === currentValue) return false;
  }

  const hasValue = Object.prototype.hasOwnProperty.call(trigger, "value");
  const operator = hasValue ? String(trigger.operator || "eq").trim() : "";
  if (hasValue) {
    if (!OPERATORS.has(operator)) return false;
    return compareValues(currentValue, operator, trigger.value);
  }

  // traitPath exists and changed requirement satisfied.
  return true;
}

function evaluateCondition(cond, ctx) {
  if (!cond || typeof cond !== "object") return false;

  if (Array.isArray(cond.all)) {
    return cond.all.every((c) => evaluateCondition(c, ctx));
  }
  if (Array.isArray(cond.any)) {
    return cond.any.some((c) => evaluateCondition(c, ctx));
  }
  if (cond.not !== undefined) {
    return !evaluateCondition(cond.not, ctx);
  }
  if (cond.time && typeof cond.time === "object") {
    return evaluateTimeWindow(cond.time, ctx?.nowMs);
  }

  const deviceId = String(cond.deviceId || "").trim();
  const traitPath = String(cond.traitPath || "").trim();
  if (!deviceId || !traitPath) return false;
  const device = ctx?.devices?.get?.(deviceId);
  if (!device) return false;
  const actual = getPathValue(device, traitPath);

  if (Object.prototype.hasOwnProperty.call(cond, "equals")) {
    return actual === cond.equals;
  }

  const operator = String(cond.operator || "eq").trim();
  if (!OPERATORS.has(operator)) return false;
  if (!Object.prototype.hasOwnProperty.call(cond, "value")) return false;
  return compareValues(actual, operator, cond.value);
}

function evaluateTimeWindow(window, nowMs) {
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const cur = now.getHours() * 60 + now.getMinutes();
  const after = typeof window.after === "string" ? parseTimeOfDayToMinutes(window.after) : null;
  const before = typeof window.before === "string" ? parseTimeOfDayToMinutes(window.before) : null;

  if (after === null && before === null) return true;
  if (after !== null && before === null) return cur >= after;
  if (after === null && before !== null) return cur < before;

  if (after <= before) {
    return cur >= after && cur < before;
  }
  // wraps midnight
  return cur >= after || cur < before;
}

function parseTimeOfDayToMinutes(s) {
  const m = String(s || "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function computeNextTimeTriggerMs(nowMs, atList) {
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const times = (atList || [])
    .map((t) => String(t || "").trim())
    .filter(Boolean);
  if (!times.length) return null;

  const candidates = [];
  for (const t of times) {
    const mins = parseTimeOfDayToMinutes(t);
    if (mins === null) continue;
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    candidates.push(next.getTime());
  }
  if (!candidates.length) return null;
  return Math.min(...candidates);
}

function buildWaitTimeoutMessage({ deviceId, waitFor, context }) {
  const op = failureOperator(waitFor.operator);
  const label = context?.sceneId ? `scene ${context.sceneId} step ${context.stepIndex || 1}` : `device ${deviceId}`;
  return `${label}: device ${deviceId} ${waitFor.traitPath} ${op} ${formatValue(waitFor.value)} within ${waitFor.timeoutMs}ms`;
}

function failureOperator(operator) {
  const map = {
    eq: "!=",
    neq: "==",
    gt: "<=",
    gte: "<",
    lt: ">=",
    lte: ">"
  };
  return map[operator] || "!=";
}

function formatValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function getPathValue(obj, path) {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = String(path || "").split(".").filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function compareValues(actual, operator, expected) {
  if (operator === "eq") return actual === expected;
  if (operator === "neq") return actual !== expected;
  const a = Number(actual);
  const b = Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (operator === "gt") return a > b;
  if (operator === "gte") return a >= b;
  if (operator === "lt") return a < b;
  if (operator === "lte") return a <= b;
  return false;
}

function normalizeStringArray(v) {
  if (typeof v === "string" && v.trim()) return [v.trim()];
  if (Array.isArray(v)) return v.map((x) => String(x || "").trim()).filter(Boolean);
  return null;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function defaultClock() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h)
  };
}
