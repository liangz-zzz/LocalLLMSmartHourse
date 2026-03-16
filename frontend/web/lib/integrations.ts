import type { Device } from "./device-types";
import { getHaEntityId, getZigbeeTopic } from "./device-types";

type HaLinkConfig = {
  overview: string;
  dashboards: string;
  areas: string;
  floors: string;
  devices: string;
  automations: string;
  scenes: string;
  history: string;
  logbook: string;
  entityPath: string;
  zigbeeDevicePath: string;
};

const DEFAULT_HA_LINKS: HaLinkConfig = {
  overview: "/",
  dashboards: "/lovelace/default_view",
  areas: "/config/areas/dashboard",
  floors: "/config/floors/dashboard",
  devices: "/config/devices/dashboard",
  automations: "/config/automation/dashboard",
  scenes: "/config/scene/dashboard",
  history: "/history",
  logbook: "/logbook",
  entityPath: "/history?entity_id={{entityId}}",
  zigbeeDevicePath: ""
};

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function normalizeBaseUrl(value?: string) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimTrailingSlash(trimmed) : "";
}

function joinExternalUrl(base: string, pathOrUrl?: string) {
  if (!base) return "";
  const candidate = String(pathOrUrl || "").trim();
  if (!candidate) return base;
  if (/^https?:\/\//i.test(candidate)) return candidate;
  if (candidate.startsWith("?") || candidate.startsWith("#")) return `${base}${candidate}`;
  return `${base}${candidate.startsWith("/") ? "" : "/"}${candidate}`;
}

function interpolateTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => encodeURIComponent(values[key] || ""));
}

function parseHaLinksConfig() {
  const raw = process.env.NEXT_PUBLIC_HA_LINKS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch (_err) {
    return {};
  }
}

export function getHaBaseUrl() {
  return normalizeBaseUrl(process.env.NEXT_PUBLIC_HA_BASE_URL);
}

export function getZ2MBaseUrl() {
  return normalizeBaseUrl(process.env.NEXT_PUBLIC_Z2M_BASE_URL);
}

export function getHaLinks(): HaLinkConfig {
  const overrides = parseHaLinksConfig();
  return {
    overview: typeof overrides.overview === "string" ? overrides.overview : DEFAULT_HA_LINKS.overview,
    dashboards: typeof overrides.dashboards === "string" ? overrides.dashboards : DEFAULT_HA_LINKS.dashboards,
    areas: typeof overrides.areas === "string" ? overrides.areas : DEFAULT_HA_LINKS.areas,
    floors: typeof overrides.floors === "string" ? overrides.floors : DEFAULT_HA_LINKS.floors,
    devices: typeof overrides.devices === "string" ? overrides.devices : DEFAULT_HA_LINKS.devices,
    automations: typeof overrides.automations === "string" ? overrides.automations : DEFAULT_HA_LINKS.automations,
    scenes: typeof overrides.scenes === "string" ? overrides.scenes : DEFAULT_HA_LINKS.scenes,
    history: typeof overrides.history === "string" ? overrides.history : DEFAULT_HA_LINKS.history,
    logbook: typeof overrides.logbook === "string" ? overrides.logbook : DEFAULT_HA_LINKS.logbook,
    entityPath: typeof overrides.entityPath === "string" ? overrides.entityPath : DEFAULT_HA_LINKS.entityPath,
    zigbeeDevicePath: typeof overrides.zigbeeDevicePath === "string" ? overrides.zigbeeDevicePath : DEFAULT_HA_LINKS.zigbeeDevicePath
  };
}

export function getHaHubLinks() {
  const base = getHaBaseUrl();
  const links = getHaLinks();
  return {
    overview: joinExternalUrl(base, links.overview),
    dashboards: joinExternalUrl(base, links.dashboards),
    areas: joinExternalUrl(base, links.areas),
    floors: joinExternalUrl(base, links.floors),
    devices: joinExternalUrl(base, links.devices),
    automations: joinExternalUrl(base, links.automations),
    scenes: joinExternalUrl(base, links.scenes),
    history: joinExternalUrl(base, links.history),
    logbook: joinExternalUrl(base, links.logbook)
  };
}

export function getDeviceHaUrl(device?: Device | null) {
  const base = getHaBaseUrl();
  const entityId = getHaEntityId(device);
  if (!base || !entityId) return "";
  return joinExternalUrl(base, interpolateTemplate(getHaLinks().entityPath, { entityId }));
}

export function getDeviceZ2MUrl(device?: Device | null) {
  const base = getZ2MBaseUrl();
  const topic = getZigbeeTopic(device);
  if (!base || !topic) return "";
  const pathTemplate = getHaLinks().zigbeeDevicePath;
  if (!pathTemplate) return base;
  return joinExternalUrl(base, interpolateTemplate(pathTemplate, { topic }));
}

export function getDeviceExternalLinks(device?: Device | null) {
  return {
    haUrl: getDeviceHaUrl(device),
    zigbee2mqttUrl: getDeviceZ2MUrl(device)
  };
}
