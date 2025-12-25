import fs from "node:fs/promises";
import path from "node:path";

const OPERATORS = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);

export class SceneStoreError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    if (extra && typeof extra === "object") {
      Object.assign(this, extra);
    }
  }
}

export class SceneStore {
  constructor({ scenesPath, logger }) {
    this.scenesPath = scenesPath || "./scenes.json";
    this.logger = logger;
  }

  resolvePath() {
    const raw = String(this.scenesPath || "").trim() || "./scenes.json";
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }

  async list() {
    const list = await this.load();
    validateSceneList(list);
    return list;
  }

  async get(id) {
    const list = await this.list();
    return list.find((scene) => scene.id === id);
  }

  async create(scene) {
    const list = await this.list();
    const id = String(scene?.id || "").trim();
    if (!id) {
      throw new SceneStoreError("invalid_scene", "scene id is required");
    }
    if (list.some((item) => item?.id === id)) {
      throw new SceneStoreError("scene_exists", `scene ${id} already exists`);
    }
    const next = list.concat([scene]);
    validateSceneList(next);
    await this.save(next);
    return scene;
  }

  async update(id, scene) {
    const list = await this.list();
    const index = list.findIndex((item) => item?.id === id);
    if (index < 0) {
      throw new SceneStoreError("scene_not_found", `scene ${id} not found`);
    }
    const next = [...list];
    next[index] = { ...scene, id };
    validateSceneList(next);
    await this.save(next);
    return next[index];
  }

  async delete(id, { cascade } = {}) {
    const list = await this.list();
    const index = list.findIndex((item) => item?.id === id);
    if (index < 0) {
      throw new SceneStoreError("scene_not_found", `scene ${id} not found`);
    }

    const reverse = buildReverseRefs(list);
    const direct = reverse.get(id) || [];
    if (direct.length && !cascade) {
      throw new SceneStoreError("scene_has_dependents", `scene ${id} has dependents`, { dependents: direct });
    }

    const remove = cascade ? collectDependents(id, reverse) : new Set([id]);
    const remaining = list.filter((scene) => !remove.has(scene.id));
    await this.save(remaining);
    return { removed: Array.from(remove) };
  }

  async expand(id) {
    const list = await this.list();
    const map = buildSceneMap(list);
    if (!map.has(id)) {
      throw new SceneStoreError("scene_not_found", `scene ${id} not found`);
    }
    const steps = expandScene(id, map, new Set());
    return steps;
  }

  async load() {
    const resolved = this.resolvePath();
    try {
      const raw = await fs.readFile(resolved, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeSceneList(parsed);
    } catch (err) {
      if (err?.code === "ENOENT") {
        return [];
      }
      throw new SceneStoreError("scene_store_read_failed", err?.message || "failed to read scenes file");
    }
  }

  async save(list) {
    const resolved = this.resolvePath();
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${resolved}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = JSON.stringify(list, null, 2);
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, resolved);
  }
}

function normalizeSceneList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.scenes)) return parsed.scenes;
    return Object.entries(parsed).map(([id, value]) => ({ id, ...(value || {}) }));
  }
  return [];
}

function validateSceneList(list) {
  const errors = [];
  if (!Array.isArray(list)) {
    throw new SceneStoreError("invalid_scene", "scenes must be an array");
  }

  const ids = new Set();
  const refs = new Map();

  list.forEach((scene, sceneIndex) => {
    if (!isPlainObject(scene)) {
      errors.push(`scene[${sceneIndex}] must be an object`);
      return;
    }
    if (typeof scene.id !== "string" || !scene.id.trim()) {
      errors.push(`scene[${sceneIndex}].id is required`);
    } else if (ids.has(scene.id)) {
      errors.push(`scene id duplicate: ${scene.id}`);
    } else {
      ids.add(scene.id);
    }

    if (typeof scene.name !== "string" || !scene.name.trim()) {
      errors.push(`scene[${sceneIndex}].name is required`);
    }
    if (typeof scene.description !== "string") {
      errors.push(`scene[${sceneIndex}].description must be string`);
    }
    if (!Array.isArray(scene.steps)) {
      errors.push(`scene[${sceneIndex}].steps must be an array`);
      return;
    }

    for (let stepIndex = 0; stepIndex < scene.steps.length; stepIndex++) {
      const step = scene.steps[stepIndex];
      const prefix = `scene[${sceneIndex}].steps[${stepIndex}]`;
      if (!isPlainObject(step)) {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      if (step.type === "device") {
        if (typeof step.deviceId !== "string" || !step.deviceId.trim()) {
          errors.push(`${prefix}.deviceId is required`);
        }
        if (typeof step.action !== "string" || !step.action.trim()) {
          errors.push(`${prefix}.action is required`);
        }
        if (step.params !== undefined && !isPlainObject(step.params)) {
          errors.push(`${prefix}.params must be an object`);
        }
        if (step.wait_for !== undefined) {
          validateWaitFor(step.wait_for, `${prefix}.wait_for`, errors);
        }
      } else if (step.type === "scene") {
        if (typeof step.sceneId !== "string" || !step.sceneId.trim()) {
          errors.push(`${prefix}.sceneId is required`);
        } else if (scene.id) {
          const list = refs.get(scene.id) || [];
          list.push(step.sceneId);
          refs.set(scene.id, list);
        }
      } else {
        errors.push(`${prefix}.type must be "device" or "scene"`);
      }
    }
  });

  for (const [owner, targets] of refs.entries()) {
    for (const target of targets) {
      if (!ids.has(target)) {
        errors.push(`scene ${owner} references missing scene ${target}`);
      }
    }
  }

  const cycle = detectCycle(ids, refs);
  if (cycle) {
    errors.push(`scene cycle detected: ${cycle.join(" -> ")}`);
  }

  if (errors.length) {
    throw new SceneStoreError("invalid_scene", errors.join("; "), { details: errors });
  }
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

function buildSceneMap(list) {
  const map = new Map();
  for (const scene of list || []) {
    if (scene && typeof scene === "object" && typeof scene.id === "string") {
      map.set(scene.id, scene);
    }
  }
  return map;
}

function buildReverseRefs(list) {
  const reverse = new Map();
  for (const scene of list || []) {
    if (!scene || typeof scene !== "object" || typeof scene.id !== "string") continue;
    for (const step of scene.steps || []) {
      if (!step || typeof step !== "object" || step.type !== "scene") continue;
      const sceneId = String(step.sceneId || "").trim();
      if (!sceneId) continue;
      const owners = reverse.get(sceneId) || [];
      if (!owners.includes(scene.id)) owners.push(scene.id);
      reverse.set(sceneId, owners);
    }
  }
  return reverse;
}

function collectDependents(rootId, reverse) {
  const remove = new Set([rootId]);
  const queue = [...(reverse.get(rootId) || [])];
  while (queue.length) {
    const next = queue.shift();
    if (!next || remove.has(next)) continue;
    remove.add(next);
    const more = reverse.get(next) || [];
    for (const item of more) {
      if (!remove.has(item)) queue.push(item);
    }
  }
  return remove;
}

function expandScene(sceneId, map, visiting) {
  if (visiting.has(sceneId)) {
    throw new SceneStoreError("invalid_scene", `scene cycle detected during expansion at ${sceneId}`);
  }
  const scene = map.get(sceneId);
  if (!scene) {
    throw new SceneStoreError("scene_not_found", `scene ${sceneId} not found`);
  }
  visiting.add(sceneId);
  const out = [];
  for (const step of scene.steps || []) {
    if (!step || typeof step !== "object") continue;
    if (step.type === "device") {
      out.push({
        type: "device",
        deviceId: step.deviceId,
        action: step.action,
        params: isPlainObject(step.params) ? step.params : {},
        ...(isPlainObject(step.wait_for) ? { wait_for: step.wait_for } : {})
      });
    } else if (step.type === "scene") {
      const target = String(step.sceneId || "").trim();
      if (!target) continue;
      out.push(...expandScene(target, map, visiting));
    }
  }
  visiting.delete(sceneId);
  return out;
}

function detectCycle(ids, refs) {
  const visiting = new Set();
  const visited = new Set();
  const path = [];
  let cycle = null;

  const dfs = (id) => {
    if (cycle) return;
    if (visiting.has(id)) {
      const idx = path.indexOf(id);
      const loop = idx >= 0 ? path.slice(idx).concat(id) : [id];
      cycle = loop;
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    path.push(id);
    const next = refs.get(id) || [];
    for (const target of next) {
      dfs(target);
      if (cycle) return;
    }
    visiting.delete(id);
    visited.add(id);
    path.pop();
  };

  for (const id of ids) {
    if (cycle) break;
    dfs(id);
  }
  return cycle;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
