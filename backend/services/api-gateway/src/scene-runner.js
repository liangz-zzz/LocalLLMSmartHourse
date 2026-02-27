export class SceneRunnerError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    if (extra && typeof extra === "object") Object.assign(this, extra);
  }
}

export class SceneRunner {
  constructor({ sceneStore, store, bus, logger, clock = Date, defaultTimeoutMs = 8000 }) {
    this.sceneStore = sceneStore;
    this.store = store;
    this.bus = bus;
    this.logger = logger;
    this.clock = clock;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async run({ sceneId, dryRun = false, confirm = false, timeoutMs, requestId }) {
    const id = String(sceneId || "").trim();
    if (!id) {
      throw new SceneRunnerError("invalid_scene_run", "scene id is required");
    }
    if (!this.sceneStore) {
      throw new SceneRunnerError("scene_run_unavailable", "scene store unavailable");
    }

    const steps = await this.sceneStore.expand(id);
    const runId = String(requestId || "").trim() || `scene_run_${this.clock.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const startedAt = this.clock.now();
    const perStepTimeoutMs = normalizeTimeout(timeoutMs, this.defaultTimeoutMs);

    const out = {
      runId,
      sceneId: id,
      status: "running",
      steps: [],
      startedAt
    };

    if (dryRun) {
      out.steps = steps.map((step, index) => ({
        index,
        deviceId: step.deviceId,
        action: step.action,
        status: "dry_run",
        params: isPlainObject(step.params) ? step.params : {}
      }));
      out.status = "ok";
      out.endedAt = this.clock.now();
      out.durationMs = out.endedAt - out.startedAt;
      return out;
    }

    if (!confirm) {
      throw new SceneRunnerError("confirmation_required", "scene run requires confirm=true for non-dry-run");
    }

    if (!this.bus?.publishAction || !this.bus?.onActionResult) {
      throw new SceneRunnerError("scene_run_unavailable", "action bus unavailable");
    }

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const deviceId = String(step.deviceId || "").trim();
      const action = String(step.action || "").trim();
      const params = isPlainObject(step.params) ? step.params : {};

      const stepResult = {
        index,
        deviceId,
        action,
        params,
        status: "queued",
        startedAt: this.clock.now()
      };

      const device = await this.store?.get?.(deviceId);
      if (!device) {
        stepResult.status = "error";
        stepResult.reason = "device_not_found";
        stepResult.endedAt = this.clock.now();
        out.steps.push(stepResult);
        continue;
      }

      const supported = Array.isArray(device.capabilities) && device.capabilities.some((item) => item?.action === action);
      if (!supported) {
        stepResult.status = "error";
        stepResult.reason = "action_not_supported";
        stepResult.endedAt = this.clock.now();
        out.steps.push(stepResult);
        continue;
      }

      await this.bus.publishAction({
        id: deviceId,
        action,
        params,
        ts: this.clock.now(),
        requestId: `${runId}:${index}`
      });

      const matched = await waitForActionResult({
        bus: this.bus,
        deviceId,
        action,
        timeoutMs: perStepTimeoutMs,
        minTs: stepResult.startedAt
      });

      if (!matched) {
        stepResult.status = "timeout";
        stepResult.reason = "result_timeout";
        stepResult.endedAt = this.clock.now();
        out.steps.push(stepResult);
        continue;
      }

      const resultStatus = String(matched.status || "").trim().toLowerCase();
      stepResult.status = resultStatus === "ok" ? "ok" : "error";
      stepResult.reason = stepResult.status === "ok" ? undefined : String(matched.reason || "action_failed");
      stepResult.transport = matched.transport;
      stepResult.endedAt = this.clock.now();
      out.steps.push(stepResult);
    }

    out.status = summarizeStatus(out.steps);
    out.endedAt = this.clock.now();
    out.durationMs = out.endedAt - out.startedAt;
    this.logger?.info?.("scene.run.completed", {
      sceneId: id,
      runId: out.runId,
      status: out.status,
      steps: out.steps.length
    });
    return out;
  }
}

function summarizeStatus(steps) {
  if (!Array.isArray(steps) || !steps.length) return "ok";
  const hasOk = steps.some((step) => step.status === "ok");
  const hasError = steps.some((step) => step.status === "error");
  const hasTimeout = steps.some((step) => step.status === "timeout");

  if (!hasError && !hasTimeout) return "ok";
  if (hasTimeout && !hasOk && !hasError) return "timeout";
  if (hasError && !hasOk && !hasTimeout) return "error";
  if (!hasOk && hasError && hasTimeout) return "error";
  return "partial_ok";
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

function normalizeTimeout(timeoutMs, fallback) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

