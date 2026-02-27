import { createHash } from "node:crypto";

const OFFLINE_STATES = new Set(["offline", "unavailable", "disconnected"]);

export class DeviceIdentityResolver {
  constructor({ store, logger } = {}) {
    this.store = store;
    this.logger = logger;
  }

  async listEnriched() {
    const list = await this.store?.list?.();
    return this.enrichDevices(list || []);
  }

  enrichDevices(list) {
    if (!Array.isArray(list)) return [];
    return list.map((item) => this.enrichDevice(item));
  }

  enrichDevice(device) {
    if (!isPlainObject(device)) return device;
    const out = clone(device);
    const provided = isPlainObject(out.identity) ? clone(out.identity) : {};
    const fingerprint = isPlainObject(provided.fingerprint) ? clone(provided.fingerprint) : buildFingerprint(out);
    const stableKey = String(provided.stableKey || "").trim() || computeStableKey(out, fingerprint);
    const aliasKeys = uniqStrings([
      ...(Array.isArray(provided.aliasKeys) ? provided.aliasKeys : []),
      out.id,
      out.name,
      ...toArray(out?.semantics?.aliases),
      ...toArray(out?.semantics?.tags),
      out?.bindings?.ha?.entity_id,
      out?.bindings?.ha_entity_id,
      out?.bindings?.zigbee2mqtt?.friendly_name,
      out?.bindings?.zigbee2mqtt?.ieee_address
    ]);

    out.identity = {
      ...provided,
      stableKey,
      fingerprint,
      aliasKeys
    };
    return out;
  }

  resolveGoal({ selector, action, devices }) {
    const candidates = this.rankCandidates({ selector, action, devices });
    const selected = candidates[0] || null;
    return {
      selected,
      candidates,
      reason: selected ? buildSelectionReason({ selector, action, selected }) : "no_candidate"
    };
  }

  rankCandidates({ selector, action, devices }) {
    const normalizedSelector = isPlainObject(selector) ? selector : {};
    const pool = this.enrichDevices(Array.isArray(devices) ? devices : []);
    const scored = [];

    for (const device of pool) {
      const score = scoreCandidate({ device, selector: normalizedSelector, action });
      if (score < 0) continue;
      scored.push({
        ...device,
        __score: score,
        __online: isDeviceOnline(device)
      });
    }

    scored.sort((a, b) => {
      if (a.__online !== b.__online) return a.__online ? -1 : 1;
      if (a.__score !== b.__score) return b.__score - a.__score;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });

    return scored.map((item) => {
      const { __score, __online, ...device } = item;
      return { ...device, selectionScore: __score, online: __online };
    });
  }
}

export function isDeviceOnline(device) {
  if (!isPlainObject(device)) return false;
  const availability = String(device?.traits?.availability?.state || device?.traits?.connectivity?.state || "")
    .trim()
    .toLowerCase();
  if (OFFLINE_STATES.has(availability)) return false;
  const telemetryOnline = device?.traits?.telemetry?.online;
  if (typeof telemetryOnline === "boolean") return telemetryOnline;
  return true;
}

function scoreCandidate({ device, selector, action }) {
  if (!isPlainObject(device)) return -1;
  const stableKey = normalizeToken(selector?.stableKey);
  const selectorDeviceId = normalizeToken(selector?.deviceId);
  const selectorRoom = normalizeToken(selector?.room);
  const selectorTags = toArray(selector?.tags).map(normalizeToken).filter(Boolean);
  const selectorQuery = normalizeToken(selector?.query);
  const selectorCapability = normalizeToken(selector?.capability);

  const deviceStableKey = normalizeToken(device?.identity?.stableKey);
  const deviceId = normalizeToken(device?.id);
  const deviceRoom = normalizeToken(device?.placement?.room);
  const deviceTags = toArray(device?.semantics?.tags).map(normalizeToken).filter(Boolean);
  const deviceAliases = toArray(device?.semantics?.aliases).map(normalizeToken).filter(Boolean);
  const deviceAliasKeys = toArray(device?.identity?.aliasKeys).map(normalizeToken).filter(Boolean);
  const supportedActions = new Set(
    toArray(device?.capabilities)
      .map((item) => normalizeToken(item?.action))
      .filter(Boolean)
  );

  if (stableKey && stableKey !== deviceStableKey) return -1;
  if (selectorDeviceId && selectorDeviceId !== deviceId) return -1;
  if (selectorRoom && selectorRoom !== deviceRoom) return -1;
  if (selectorTags.length && !selectorTags.every((tag) => deviceTags.includes(tag))) return -1;
  if (selectorCapability && !supportedActions.has(selectorCapability)) return -1;
  if (action && !supportedActions.has(normalizeToken(action))) return -1;

  if (selectorQuery) {
    const haystack = [
      device?.id,
      device?.name,
      ...(deviceAliases || []),
      ...(deviceAliasKeys || []),
      device?.semantics?.summary,
      device?.semantics?.description,
      device?.placement?.room
    ]
      .map(normalizeToken)
      .join(" ");
    if (!haystack.includes(selectorQuery)) return -1;
  }

  let score = 0;
  if (stableKey) score += 100;
  if (selectorDeviceId) score += 95;
  if (selectorRoom) score += 20;
  if (selectorTags.length) score += selectorTags.length * 8;
  if (selectorQuery) score += 12;
  if (selectorCapability) score += 16;
  if (action) score += 16;
  if (isDeviceOnline(device)) score += 8;

  if (!stableKey && !selectorDeviceId && !selectorRoom && !selectorTags.length && !selectorQuery && !selectorCapability) {
    score += 1;
  }

  return score;
}

function buildSelectionReason({ selector, action, selected }) {
  const selectorSummary = {
    stableKey: selector?.stableKey || undefined,
    deviceId: selector?.deviceId || undefined,
    room: selector?.room || undefined,
    tags: Array.isArray(selector?.tags) ? selector.tags : undefined,
    query: selector?.query || undefined,
    capability: selector?.capability || undefined
  };
  return JSON.stringify({ action: action || undefined, selector: selectorSummary, selected: selected?.id || undefined });
}

function buildFingerprint(device) {
  return {
    protocol: String(device?.protocol || ""),
    room: String(device?.placement?.room || ""),
    zone: String(device?.placement?.zone || ""),
    vendor: String(device?.semantics?.vendor || ""),
    model: String(device?.semantics?.model || ""),
    ha_entity_id: String(device?.bindings?.ha?.entity_id || device?.bindings?.ha_entity_id || ""),
    zigbee_topic: String(device?.bindings?.zigbee2mqtt?.topic || ""),
    zigbee_ieee_address: String(device?.bindings?.zigbee2mqtt?.ieee_address || "")
  };
}

function computeStableKey(device, fingerprint) {
  const parts = [
    String(device?.protocol || ""),
    String(device?.placement?.room || ""),
    String(device?.semantics?.vendor || ""),
    String(device?.semantics?.model || ""),
    String(fingerprint?.zigbee_ieee_address || ""),
    String(fingerprint?.ha_entity_id || ""),
    String(device?.name || ""),
    String(device?.id || "")
  ];
  const digest = createHash("sha1")
    .update(parts.join("|"))
    .digest("hex")
    .slice(0, 16);
  return `stable_${digest}`;
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of toArray(values)) {
    const key = normalizeToken(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(value));
  }
  return out;
}
