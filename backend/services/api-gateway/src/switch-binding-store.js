export class SwitchBindingStoreError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    if (extra && typeof extra === "object") Object.assign(this, extra);
  }
}

export class SwitchBindingStore {
  constructor({ automationStore, deviceStore, sceneStore }) {
    this.automationStore = automationStore;
    this.deviceStore = deviceStore;
    this.sceneStore = sceneStore;
  }

  async list({ panelId } = {}) {
    const items = (await this.automationStore.list()).filter((item) => item?.kind === "switch_binding").map(fromAutomation);
    const expectedPanel = String(panelId || "").trim();
    return expectedPanel ? items.filter((item) => item.source.panelId === expectedPanel) : items;
  }

  async get(id) {
    const item = await this.automationStore.get(id);
    return item?.kind === "switch_binding" ? fromAutomation(item) : undefined;
  }

  async create(input) {
    const compiled = await this.validateAndCompile(input);
    await this.automationStore.create(compiled);
    return fromAutomation(compiled);
  }

  async validate(input, { currentId } = {}) {
    const compiled = await this.validateAndCompile(input, { currentId });
    return fromAutomation(compiled);
  }

  async update(id, input) {
    const compiled = await this.validateAndCompile({ ...(input || {}), id }, { currentId: id });
    await this.automationStore.update(id, compiled);
    return fromAutomation(compiled);
  }

  async delete(id) {
    const found = await this.get(id);
    if (!found) throw new SwitchBindingStoreError("switch_binding_not_found", `switch binding ${id} not found`);
    return await this.automationStore.delete(id);
  }

  async validateAndCompile(input, { currentId } = {}) {
    const id = String(input?.id || "").trim();
    if (!id) throw invalid("switch binding id is required");
    const source = normalizeSource(input?.source);
    const targets = normalizeTargets(input?.targets);
    if (!targets.length) throw invalid("switch binding targets must be a non-empty array");

    const devices = await this.deviceStore.list();
    const deviceMap = new Map(devices.map((device) => [String(device?.id || ""), device]));
    const panel = deviceMap.get(source.panelId);
    if (!panel || panel?.composition?.role !== "panel") throw invalid(`panel not found: ${source.panelId}`);
    const children = devices.filter(
      (device) => device?.composition?.role === "relay_channel" && device?.composition?.parentId === source.panelId
    );
    const childByEndpoint = new Map(children.map((device) => [String(device?.composition?.endpoint || ""), device]));
    validateSelector(source, childByEndpoint);

    for (const target of targets) {
      if (target.type === "scene") {
        const scene = await this.sceneStore?.get?.(target.sceneId);
        if (!scene) throw invalid(`scene not found: ${target.sceneId}`);
        continue;
      }
      const device = deviceMap.get(target.deviceId);
      if (!device) throw invalid(`target device not found: ${target.deviceId}`);
      const capability = (device.capabilities || []).find((item) => item?.action === target.action);
      if (!capability) throw invalid(`target action not supported: ${target.deviceId}.${target.action}`);
      validateParams(capability, target.params || {}, `${target.deviceId}.${target.action}`);
    }

    const sourceChild = childByEndpoint.get(source.selector);
    if (source.trigger.type === "state" && targets.some((target) => target.type === "device" && target.deviceId === sourceChild.id)) {
      throw invalid("state binding cannot target its own source channel");
    }

    const existing = await this.list();
    const sourceKey = bindingSourceKey(source);
    const duplicate = existing.find((item) => item.id !== currentId && bindingSourceKey(item.source) === sourceKey);
    if (duplicate) throw new SwitchBindingStoreError("switch_binding_exists", `source already bound by ${duplicate.id}`);

    const candidate = {
      id,
      name: String(input?.name || id).trim() || id,
      enabled: input?.enabled !== false,
      source,
      targets
    };
    validateStateBindingCycles(existing.filter((item) => item.id !== currentId).concat(candidate), devices);
    return toAutomation(candidate, sourceChild);
  }
}

function normalizeSource(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const panelId = String(source.panelId || "").trim();
  const selector = String(source.selector || "").trim();
  const triggerRaw = source.trigger && typeof source.trigger === "object" ? source.trigger : {};
  const type = String(triggerRaw.type || "").trim();
  if (!panelId) throw invalid("source.panelId is required");
  if (!selector) throw invalid("source.selector is required");
  if (type === "button") {
    const gesture = String(triggerRaw.gesture || "").trim();
    if (!['single', 'double'].includes(gesture)) throw invalid("source.trigger.gesture must be single or double");
    return { panelId, selector, trigger: { type: "button", gesture } };
  }
  if (type === "state") {
    const value = String(triggerRaw.value || "").trim();
    if (!['on', 'off'].includes(value)) throw invalid("source.trigger.value must be on or off");
    return { panelId, selector, trigger: { type: "state", value } };
  }
  throw invalid("source.trigger.type must be button or state");
}

function normalizeTargets(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((target) => {
    if (target?.type === "scene") {
      const sceneId = String(target.sceneId || "").trim();
      if (!sceneId) throw invalid("target.sceneId is required");
      return { type: "scene", sceneId };
    }
    if (target?.type === "device") {
      const deviceId = String(target.deviceId || "").trim();
      const action = String(target.action || "").trim();
      if (!deviceId || !action) throw invalid("device target requires deviceId and action");
      return { type: "device", deviceId, action, ...(target.params ? { params: target.params } : {}) };
    }
    throw invalid('target.type must be "device" or "scene"');
  });
}

function validateSelector(source, childByEndpoint) {
  if (source.trigger.type === "state") {
    if (!childByEndpoint.has(source.selector)) throw invalid(`state selector is not a channel: ${source.selector}`);
    return;
  }
  if (childByEndpoint.has(source.selector)) return;
  const endpoints = new Set(childByEndpoint.keys());
  const supportedCombos =
    endpoints.size === 2
      ? new Set(["both"])
      : endpoints.size >= 3
        ? new Set(["left_center", "left_right", "center_right", "all"])
        : new Set();
  if (supportedCombos.has(source.selector)) return;
  throw invalid(`button selector is not available on panel: ${source.selector}`);
}

function validateParams(capability, params, label) {
  for (const spec of capability?.parameters || []) {
    const value = params?.[spec.name];
    if (value === undefined) {
      if (spec.required) throw invalid(`${label}: param ${spec.name} is required`);
      continue;
    }
    if (spec.type === "number") {
      if (typeof value !== "number") throw invalid(`${label}: param ${spec.name} must be number`);
      if (spec.minimum !== undefined && value < spec.minimum) throw invalid(`${label}: param ${spec.name} below minimum`);
      if (spec.maximum !== undefined && value > spec.maximum) throw invalid(`${label}: param ${spec.name} above maximum`);
    }
    if (spec.type === "boolean" && typeof value !== "boolean") throw invalid(`${label}: param ${spec.name} must be boolean`);
    if (spec.type === "string" && typeof value !== "string") throw invalid(`${label}: param ${spec.name} must be string`);
    if (spec.type === "enum" && !Array.isArray(spec.enum)) throw invalid(`${label}: invalid enum schema`);
    if (spec.type === "enum" && !spec.enum.includes(value)) throw invalid(`${label}: param ${spec.name} is not allowed`);
  }
}

function toAutomation(binding, sourceChild) {
  const source = binding.source;
  const trigger =
    source.trigger.type === "button"
      ? {
          type: "device_event",
          deviceId: source.panelId,
          eventType: "button",
          gesture: source.trigger.gesture,
          selector: source.selector
        }
      : {
          type: "device",
          deviceId: sourceChild.id,
          traitPath: "traits.switch.state",
          operator: "eq",
          value: source.trigger.value,
          changed: true
        };
  return {
    id: binding.id,
    name: binding.name,
    enabled: binding.enabled,
    kind: "switch_binding",
    binding: { source },
    trigger,
    cooldownMs: source.trigger.type === "state" ? 500 : 0,
    then: binding.targets
  };
}

function fromAutomation(automation) {
  return {
    id: automation.id,
    name: automation.name || automation.id,
    enabled: automation.enabled !== false,
    source: automation.binding?.source,
    targets: Array.isArray(automation.then) ? automation.then : []
  };
}

function bindingSourceKey(source) {
  const triggerValue = source.trigger.type === "button" ? source.trigger.gesture : source.trigger.value;
  return [source.panelId, source.selector, source.trigger.type, triggerValue].join("|");
}

function validateStateBindingCycles(bindings, devices) {
  const channelByPanelEndpoint = new Map();
  for (const device of devices) {
    if (device?.composition?.role !== "relay_channel") continue;
    channelByPanelEndpoint.set(`${device.composition.parentId}|${device.composition.endpoint}`, device.id);
  }
  const graph = new Map();
  for (const binding of bindings) {
    if (binding?.source?.trigger?.type !== "state") continue;
    const sourceId = channelByPanelEndpoint.get(`${binding.source.panelId}|${binding.source.selector}`);
    if (!sourceId) continue;
    const targets = (binding.targets || []).filter((target) => target.type === "device").map((target) => target.deviceId);
    graph.set(sourceId, [...(graph.get(sourceId) || []), ...targets]);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (node) => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) || []) if (graph.has(next) && visit(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const node of graph.keys()) if (visit(node)) throw invalid("state binding cycle detected");
}

function invalid(message) {
  return new SwitchBindingStoreError("invalid_switch_binding", message);
}
