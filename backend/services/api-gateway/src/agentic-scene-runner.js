import { SceneRunnerError } from "./scene-runner.js";
import { DeviceIdentityResolver } from "./device-identity.js";

const RISK_LEVELS = ["low", "medium", "high"];

export class AgenticSceneRunner {
  constructor({
    sceneStore,
    store,
    bus,
    logger,
    clock = Date,
    defaultTimeoutMs = 8000,
    runTtlMs = 60 * 60 * 1000,
    identityResolver
  }) {
    this.sceneStore = sceneStore;
    this.store = store;
    this.bus = bus;
    this.logger = logger;
    this.clock = clock;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.runTtlMs = runTtlMs;
    this.identityResolver = identityResolver || new DeviceIdentityResolver({ store, logger });
    this.runs = new Map();
  }

  async plan({ sceneId, requestId, context }) {
    const scene = await this.loadScene(sceneId);
    const runId = normalizeRequestId(requestId) || `scene_plan_${this.clock.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const planned = await this.buildPlan({ scene, context, runId });

    return {
      runId,
      sceneId: scene.id,
      mode: "agentic",
      type: "plan",
      ordering: planned.ordering,
      fallbackPolicy: planned.fallbackPolicy,
      risk: planned.risk,
      decisions: planned.decisions,
      steps: planned.steps
    };
  }

  async run({ sceneId, dryRun = false, confirm = false, timeoutMs, requestId, context }) {
    const scene = await this.loadScene(sceneId);
    const runId = normalizeRequestId(requestId) || `scene_run_agentic_${this.clock.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const startedAt = this.clock.now();
    const planned = await this.buildPlan({ scene, context, runId });

    if (!dryRun && planned.risk.requiresConfirm && !confirm) {
      throw new SceneRunnerError(
        "confirmation_required",
        `agentic scene requires confirm=true for ${planned.risk.maxLevel} risk actions`
      );
    }

    const out = {
      runId,
      sceneId: scene.id,
      mode: "agentic",
      status: "running",
      ordering: planned.ordering,
      fallbackPolicy: planned.fallbackPolicy,
      risk: planned.risk,
      decisions: planned.decisions,
      steps: [],
      startedAt
    };

    if (dryRun) {
      out.steps = planned.steps.map((step) => ({
        ...step,
        status: step.status === "skipped" ? "skipped" : "dry_run",
        startedAt,
        endedAt: this.clock.now()
      }));
      out.status = summarizeStatus(out.steps);
      out.endedAt = this.clock.now();
      out.durationMs = out.endedAt - out.startedAt;
      this.saveRun(out);
      return out;
    }

    if (!this.bus?.publishAction || !this.bus?.onActionResult) {
      throw new SceneRunnerError("scene_run_unavailable", "action bus unavailable");
    }

    const perStepTimeoutMs = normalizeTimeout(timeoutMs, this.defaultTimeoutMs);

    for (const plannedStep of planned.steps) {
      const stepResult = {
        ...plannedStep,
        startedAt: this.clock.now(),
        status: plannedStep.status === "skipped" ? "skipped" : "queued"
      };

      if (plannedStep.status === "skipped") {
        stepResult.endedAt = this.clock.now();
        out.steps.push(stepResult);
        if (planned.fallbackPolicy === "abort") break;
        continue;
      }

      const device = await this.store?.get?.(plannedStep.deviceId);
      if (!device) {
        stepResult.status = "skipped";
        stepResult.reason = "device_not_found";
        stepResult.endedAt = this.clock.now();
        out.steps.push(stepResult);
        if (planned.fallbackPolicy === "abort") break;
        continue;
      }

      const supported = Array.isArray(device.capabilities) && device.capabilities.some((item) => item?.action === plannedStep.action);
      if (!supported) {
        stepResult.status = "error";
        stepResult.reason = "action_not_supported";
        stepResult.endedAt = this.clock.now();
        out.steps.push(stepResult);
        if (planned.fallbackPolicy === "abort") break;
        continue;
      }

      await this.bus.publishAction({
        id: plannedStep.deviceId,
        action: plannedStep.action,
        params: isPlainObject(plannedStep.params) ? plannedStep.params : {},
        ts: this.clock.now(),
        requestId: `${runId}:${plannedStep.index}`
      });

      const matched = await waitForActionResult({
        bus: this.bus,
        deviceId: plannedStep.deviceId,
        action: plannedStep.action,
        timeoutMs: perStepTimeoutMs,
        minTs: stepResult.startedAt
      });

      if (!matched) {
        stepResult.status = "timeout";
        stepResult.reason = "result_timeout";
        stepResult.endedAt = this.clock.now();
        out.steps.push(stepResult);
        if (planned.fallbackPolicy === "abort") break;
        continue;
      }

      const resultStatus = String(matched.status || "").trim().toLowerCase();
      stepResult.status = resultStatus === "ok" ? "ok" : "error";
      stepResult.reason = stepResult.status === "ok" ? undefined : String(matched.reason || "action_failed");
      stepResult.transport = matched.transport;

      if (stepResult.status === "ok" && isPlainObject(plannedStep.wait_for)) {
        const waitResult = await waitForStateCondition({
          store: this.store,
          deviceId: plannedStep.deviceId,
          waitFor: plannedStep.wait_for
        });
        if (!waitResult.ok) {
          stepResult.status = "timeout";
          stepResult.reason = "scene_wait_timeout";
        }
      }

      stepResult.endedAt = this.clock.now();
      out.steps.push(stepResult);

      if (stepResult.status !== "ok" && planned.fallbackPolicy === "abort") break;
    }

    out.status = summarizeStatus(out.steps);
    out.endedAt = this.clock.now();
    out.durationMs = out.endedAt - out.startedAt;
    this.saveRun(out);
    this.logger?.info?.("scene.agentic.completed", {
      runId: out.runId,
      sceneId: out.sceneId,
      status: out.status,
      steps: out.steps.length
    });
    return out;
  }

  getRun(runId) {
    const id = String(runId || "").trim();
    if (!id) {
      throw new SceneRunnerError("invalid_scene_run", "runId is required");
    }
    this.gcRuns();
    const found = this.runs.get(id);
    if (!found) {
      throw new SceneRunnerError("scene_run_not_found", `scene run ${id} not found`);
    }
    return clone(found.value);
  }

  async loadScene(sceneId) {
    const id = String(sceneId || "").trim();
    if (!id) {
      throw new SceneRunnerError("invalid_scene_run", "scene id is required");
    }
    if (!this.sceneStore) {
      throw new SceneRunnerError("scene_run_unavailable", "scene store unavailable");
    }
    const scene = await this.sceneStore.get(id);
    if (!scene) {
      throw new SceneRunnerError("scene_not_found", `scene ${id} not found`);
    }
    if (!Array.isArray(scene?.intent?.goals) || !scene.intent.goals.length) {
      throw new SceneRunnerError("invalid_scene_run", "scene is not agentic (intent.goals required)");
    }
    return scene;
  }

  async buildPlan({ scene, context, runId }) {
    const devices = await this.identityResolver.listEnriched();
    const goals = sortGoals(scene.intent.goals, scene.ordering);
    const constraints = Array.isArray(scene.constraints) ? scene.constraints : [];

    const steps = [];
    const decisions = [];
    let maxRisk = "low";

    for (let index = 0; index < goals.length; index += 1) {
      const goal = goals[index];
      const selector = isPlainObject(goal?.selector) ? goal.selector : {};
      const action = String(goal?.action || "").trim();
      const params = isPlainObject(goal?.params) ? goal.params : {};
      const waitFor = isPlainObject(goal?.wait_for) ? goal.wait_for : undefined;
      const goalId = String(goal?.id || `goal_${index + 1}`).trim();
      const optional = goal?.optional === true;

      const ranked = this.identityResolver.rankCandidates({ selector, action, devices });
      const constrained = applySceneConstraints(ranked, constraints);
      const selected = constrained[0] || null;

      const risk = normalizeRiskLevel(goal?.risk || inferRiskLevel({ device: selected, action }));
      maxRisk = maxRiskLevel(maxRisk, risk);

      if (!selected) {
        const reason = optional ? "no_candidate_optional" : "no_candidate";
        steps.push({
          index,
          goalId,
          selector,
          action,
          params,
          wait_for: waitFor,
          status: "skipped",
          reason,
          runId
        });
        decisions.push({
          index,
          goalId,
          decision: "skip",
          reason,
          selector,
          action
        });
        continue;
      }

      steps.push({
        index,
        goalId,
        selector,
        action,
        params,
        wait_for: waitFor,
        deviceId: selected.id,
        stableKey: selected?.identity?.stableKey,
        deviceName: selected.name,
        selectionScore: selected.selectionScore,
        online: selected.online,
        risk,
        status: "planned",
        runId
      });
      decisions.push({
        index,
        goalId,
        decision: "select",
        action,
        selector,
        selected: {
          id: selected.id,
          stableKey: selected?.identity?.stableKey,
          name: selected.name,
          score: selected.selectionScore
        },
        rationale: `selected highest score candidate for action ${action}`
      });
    }

    const requireConfirmOn = normalizeConfirmLevels(scene?.risk?.requireConfirmOn);
    return {
      ordering: normalizeOrdering(scene.ordering),
      fallbackPolicy: normalizeFallbackPolicy(scene?.fallback?.policy),
      steps,
      decisions,
      risk: {
        maxLevel: maxRisk,
        requireConfirmOn,
        requiresConfirm: requireConfirmOn.includes(maxRisk)
      }
    };
  }

  saveRun(run) {
    this.gcRuns();
    this.runs.set(run.runId, {
      ts: this.clock.now(),
      value: clone(run)
    });
  }

  gcRuns() {
    const now = this.clock.now();
    for (const [key, record] of this.runs.entries()) {
      if (!record || now - Number(record.ts || 0) > this.runTtlMs) {
        this.runs.delete(key);
      }
    }
  }
}

function applySceneConstraints(candidates, constraints) {
  let out = Array.isArray(candidates) ? [...candidates] : [];
  for (const item of Array.isArray(constraints) ? constraints : []) {
    if (!isPlainObject(item)) continue;
    const type = String(item.type || "").trim().toLowerCase();
    const value = String(item.value || "").trim().toLowerCase();
    if (!type || !value) continue;

    if (type === "room") {
      out = out.filter((device) => String(device?.placement?.room || "").trim().toLowerCase() === value);
      continue;
    }
    if (type === "protocol") {
      out = out.filter((device) => String(device?.protocol || "").trim().toLowerCase() === value);
      continue;
    }
    if (type === "include_tag") {
      out = out.filter((device) =>
        Array.isArray(device?.semantics?.tags) &&
        device.semantics.tags.map((tag) => String(tag || "").trim().toLowerCase()).includes(value)
      );
      continue;
    }
    if (type === "exclude_tag") {
      out = out.filter(
        (device) =>
          !(
            Array.isArray(device?.semantics?.tags) &&
            device.semantics.tags.map((tag) => String(tag || "").trim().toLowerCase()).includes(value)
          )
      );
    }
  }
  return out;
}

function normalizeRiskLevel(level) {
  const key = String(level || "").trim().toLowerCase();
  return RISK_LEVELS.includes(key) ? key : "low";
}

function inferRiskLevel({ device, action }) {
  const key = String(action || "").trim().toLowerCase();
  const voiceRisk = String(device?.bindings?.voice_control?.actions?.[action]?.risk || "").trim().toLowerCase();
  if (RISK_LEVELS.includes(voiceRisk)) return voiceRisk;
  if (["unlock", "disarm_alarm", "open_door", "open_garage"].some((item) => key.includes(item))) return "high";
  if (key.startsWith("set_") || key.includes("temperature") || key.includes("mode")) return "medium";
  return "low";
}

function maxRiskLevel(a, b) {
  const ai = RISK_LEVELS.indexOf(normalizeRiskLevel(a));
  const bi = RISK_LEVELS.indexOf(normalizeRiskLevel(b));
  return RISK_LEVELS[Math.max(ai, bi)] || "low";
}

function normalizeConfirmLevels(list) {
  const raw = Array.isArray(list) ? list : ["high"];
  const levels = raw
    .map((item) => normalizeRiskLevel(item))
    .filter((item, idx, arr) => arr.indexOf(item) === idx);
  return levels.length ? levels : ["high"];
}

function normalizeFallbackPolicy(policy) {
  const key = String(policy || "skip_continue")
    .trim()
    .toLowerCase();
  if (key === "abort") return "abort";
  return "skip_continue";
}

function normalizeOrdering(ordering) {
  const key = String(ordering || "declared")
    .trim()
    .toLowerCase();
  if (["declared", "safety_first", "comfort_first", "energy_first"].includes(key)) return key;
  return "declared";
}

function sortGoals(goals, ordering) {
  const normalizedOrdering = normalizeOrdering(ordering);
  const list = Array.isArray(goals) ? goals.map((goal, index) => ({ goal, index })) : [];
  if (normalizedOrdering === "declared") return list.map((item) => item.goal);

  const scored = list.map((item) => ({
    ...item,
    score: orderingScore(item.goal, normalizedOrdering)
  }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });
  return scored.map((item) => item.goal);
}

function orderingScore(goal, ordering) {
  const action = String(goal?.action || "")
    .trim()
    .toLowerCase();
  if (ordering === "safety_first") {
    if (action === "turn_off") return 100;
    if (action.includes("close") || action.includes("lock")) return 80;
  }
  if (ordering === "energy_first") {
    if (action === "turn_off") return 100;
    if (action.includes("set_temperature")) return 70;
  }
  if (ordering === "comfort_first") {
    if (action === "turn_on") return 80;
    if (action.includes("set_temperature")) return 90;
  }
  const priority = Number(goal?.priority);
  return Number.isFinite(priority) ? priority : 0;
}

function summarizeStatus(steps) {
  if (!Array.isArray(steps) || !steps.length) return "ok";
  const hasOk = steps.some((step) => step.status === "ok" || step.status === "dry_run");
  const hasError = steps.some((step) => step.status === "error");
  const hasTimeout = steps.some((step) => step.status === "timeout");
  const hasSkipped = steps.some((step) => step.status === "skipped");

  if (!hasError && !hasTimeout && !hasSkipped) return "ok";
  if ((hasError || hasTimeout) && hasOk) return "partial_ok";
  if (hasSkipped && hasOk && !hasError && !hasTimeout) return "partial_ok";
  if (hasTimeout && !hasError) return "timeout";
  if (hasError && !hasTimeout) return "error";
  if (hasError || hasTimeout || hasSkipped) return "partial_ok";
  return "ok";
}

function waitForActionResult({ bus, deviceId, action, timeoutMs, minTs }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(value);
    };

    const unsubscribe = bus.onActionResult((result) => {
      if (!isPlainObject(result)) return;
      if (String(result.deviceId || "").trim() !== deviceId) return;
      if (String(result.action || "").trim() !== action) return;
      if (Number(result.ts) && Number(result.ts) < Number(minTs || 0)) return;
      done(result);
    });

    const timer = setTimeout(() => done(null), timeoutMs);
  });
}

async function waitForStateCondition({ store, deviceId, waitFor }) {
  const timeoutMs = Number(waitFor.timeoutMs);
  const pollMs = Number.isFinite(waitFor.pollMs) ? Number(waitFor.pollMs) : 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const device = await store?.get?.(deviceId);
    const state = {
      id: deviceId,
      traits: device?.traits || {}
    };
    const value = getPathValue(state, waitFor.traitPath);
    if (compareValues(value, waitFor.operator, waitFor.value)) {
      return { ok: true, value };
    }
    if (Date.now() + pollMs > deadline) break;
    await sleep(pollMs);
  }

  return { ok: false };
}

function getPathValue(obj, path) {
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

function normalizeTimeout(timeoutMs, fallback) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeRequestId(value) {
  const id = String(value || "").trim();
  return id || "";
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
