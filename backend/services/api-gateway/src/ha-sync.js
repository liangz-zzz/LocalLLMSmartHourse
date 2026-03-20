import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import YAML from "yaml";

import { filterDevicesForFloorplan, getSceneScopeFloorplanIds, sceneMatchesFloorplan } from "./floorplan-utils.js";

const MANAGED_PREFIX = "smarthouse__";
const FLOORPLAN_ALIAS_PREFIX = "__smarthouse__floorplan:";
const ROOM_ALIAS_PREFIX = "__smarthouse__room:";
const DASHBOARD_ICON = "mdi:floor-plan";
const SCRIPT_ICON = "mdi:script-text-play";
const SCENE_ICON = "mdi:palette-swatch";
const REST_COMMAND_KEY = `${MANAGED_PREFIX}scene_run`;

export class HomeAssistantMirrorService {
  constructor({ config, logger, floorplanStore, sceneStore, store }) {
    this.config = config;
    this.logger = logger;
    this.floorplanStore = floorplanStore;
    this.sceneStore = sceneStore;
    this.store = store;
    this.debounceTimer = null;
    this.intervalTimer = null;
    this.currentRun = null;
    this.status = {
      running: false,
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: "",
      lastReport: null,
      queuedReason: ""
    };
  }

  get enabled() {
    return Boolean(
      this.config?.haSyncEnabled &&
        this.config?.haBaseUrl &&
        this.config?.haToken &&
        this.config?.haSyncPublicApiBaseUrl &&
        this.config?.haSyncHomeAssistantConfigDir
    );
  }

  get disabledReason() {
    if (this.enabled) return "";
    if (!this.config?.haSyncEnabled) return "ha_sync_disabled";
    if (!this.config?.haBaseUrl) return "ha_base_url_missing";
    if (!this.config?.haToken) return "ha_token_missing";
    if (!this.config?.haSyncPublicApiBaseUrl) return "ha_sync_public_api_base_missing";
    if (!this.config?.haSyncHomeAssistantConfigDir) return "ha_sync_config_dir_missing";
    return "ha_sync_unavailable";
  }

  getStatus() {
    return {
      enabled: this.enabled,
      reason: this.disabledReason || undefined,
      running: this.status.running,
      lastRunAt: this.status.lastRunAt,
      lastSuccessAt: this.status.lastSuccessAt,
      lastError: this.status.lastError || undefined,
      lastReport: this.status.lastReport || undefined,
      queuedReason: this.status.queuedReason || undefined
    };
  }

  start() {
    if (!this.enabled) return;
    if (this.intervalTimer) return;
    this.schedule("startup");
    if (this.config.haSyncIntervalMs > 0) {
      this.intervalTimer = setInterval(() => {
        this.runSync("interval").catch((err) => {
          this.logger?.warn?.("ha.sync.interval_failed", { message: err?.message || String(err) });
        });
      }, this.config.haSyncIntervalMs);
    }
  }

  stop() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  schedule(reason = "queued") {
    if (!this.enabled) return false;
    this.status.queuedReason = String(reason || "").trim() || "queued";
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.runSync(this.status.queuedReason).catch((err) => {
        this.logger?.warn?.("ha.sync.debounced_failed", { message: err?.message || String(err) });
      });
    }, this.config.haSyncDebounceMs);
    return true;
  }

  async runSync(reason = "manual") {
    if (!this.enabled) {
      return this.getStatus();
    }
    if (this.currentRun) {
      this.status.queuedReason = String(reason || "").trim() || "manual";
      return this.currentRun;
    }

    this.currentRun = this.#run(reason);
    try {
      return await this.currentRun;
    } finally {
      this.currentRun = null;
    }
  }

  async #run(reason) {
    const startedAt = new Date().toISOString();
    this.status.running = true;
    this.status.lastRunAt = startedAt;
    this.status.queuedReason = "";

    try {
      const report = await this.#reconcile(reason);
      this.status.lastSuccessAt = new Date().toISOString();
      this.status.lastError = "";
      this.status.lastReport = report;
      return this.getStatus();
    } catch (err) {
      const message = err?.message || String(err);
      this.status.lastError = message;
      this.status.lastReport = {
        reason,
        startedAt,
        ok: false,
        message
      };
      throw err;
    } finally {
      this.status.running = false;
    }
  }

  async #reconcile(reason) {
    const [floorplans, scenes, devices] = await Promise.all([this.floorplanStore.list(), this.sceneStore.list(), this.store.list()]);
    const ws = new HomeAssistantWsClient({
      baseUrl: this.config.haBaseUrl,
      token: this.config.haToken,
      logger: this.logger
    });

    try {
      await ws.connect();

      const [existingFloors, existingAreas, existingDevices, existingEntities, existingDashboards] = await Promise.all([
        ws.call("config/floor_registry/list"),
        ws.call("config/area_registry/list"),
        ws.call("config/device_registry/list"),
        ws.call("config/entity_registry/list"),
        ws.call("lovelace/dashboards/list")
      ]);

      const floorOutcome = await reconcileFloors({ ws, floorplans, existingFloors });
      const areaOutcome = await reconcileAreas({
        ws,
        floorplans,
        floorEntriesByFloorplanId: floorOutcome.entriesByFloorplanId,
        existingAreas
      });
      const deviceOutcome = await reconcileDeviceAreas({
        ws,
        floorplans,
        devices,
        existingDevices,
        existingEntities,
        areaEntriesByRoomKey: areaOutcome.entriesByRoomKey
      });
      const exportOutcome = await syncGeneratedHaFiles({
        homeAssistantConfigDir: this.config.haSyncHomeAssistantConfigDir,
        publicApiBaseUrl: this.config.haSyncPublicApiBaseUrl,
        internalApiBaseUrl: this.config.haSyncInternalApiBaseUrl,
        apiKey: this.config.haSyncApiKey,
        floorplans,
        scenes,
        devices
      });
      const dashboardOutcome = await reconcileDashboards({
        ws,
        floorplans,
        devices,
        scenes,
        existingDashboards,
        publicApiBaseUrl: this.config.haSyncPublicApiBaseUrl,
        exportOutcome
      });

      await Promise.all([
        reloadHaDomainService({ baseUrl: this.config.haBaseUrl, token: this.config.haToken, domain: "rest_command", service: "reload" }),
        reloadHaDomainService({ baseUrl: this.config.haBaseUrl, token: this.config.haToken, domain: "scene", service: "reload" }),
        reloadHaDomainService({ baseUrl: this.config.haBaseUrl, token: this.config.haToken, domain: "script", service: "reload" })
      ]);

      return {
        ok: true,
        reason,
        syncedAt: new Date().toISOString(),
        counts: {
          floorplans: floorplans.length,
          floorsCreated: floorOutcome.created,
          floorsUpdated: floorOutcome.updated,
          floorsDeleted: floorOutcome.deleted,
          areasCreated: areaOutcome.created,
          areasUpdated: areaOutcome.updated,
          areasDeleted: areaOutcome.deleted,
          deviceAssignments: deviceOutcome.updated,
          dashboardsCreated: dashboardOutcome.created,
          dashboardsUpdated: dashboardOutcome.updated,
          dashboardsDeleted: dashboardOutcome.deleted,
          exportedScenes: exportOutcome.sceneCount,
          exportedScripts: exportOutcome.scriptCount
        }
      };
    } finally {
      await ws.close();
    }
  }
}

export function buildManagedDashboardUrlPath(floorplanId) {
  return `smarthouse-${slugSegment(floorplanId)}`;
}

export function buildManagedSceneKey(sceneId) {
  return `${MANAGED_PREFIX}${sanitizeKey(sceneId)}`;
}

export function buildFloorplanDashboardConfig({ floorplan, devices, scenes, publicApiBaseUrl, exportOutcome }) {
  const scopedDevices = filterDevicesForFloorplan(devices, floorplan);
  const haDevices = scopedDevices.filter((device) => getHaEntityId(device));
  const entities = haDevices.map((device) => getHaEntityId(device));
  const roomDeviceCounts = new Map();
  for (const entry of floorplan.devices || []) {
    const key = String(entry?.roomId || "").trim() || "__unassigned__";
    roomDeviceCounts.set(key, (roomDeviceCounts.get(key) || 0) + 1);
  }

  const sceneButtons = [];
  const scriptButtons = [];
  for (const scene of scenes) {
    if (!sceneMatchesFloorplan(scene, floorplan.id)) continue;
    const sceneKey = exportOutcome.sceneEntityIdsBySceneId[scene.id];
    const scriptKey = exportOutcome.scriptEntityIdsBySceneId[scene.id];
    if (sceneKey) {
      sceneButtons.push(buildButtonCard({ name: scene.name, entityId: sceneKey, service: "scene.turn_on" }));
    } else if (scriptKey) {
      scriptButtons.push(buildButtonCard({ name: scene.name, entityId: scriptKey, service: "script.turn_on" }));
    }
  }

  const cards = [];
  const imageUrl = toAbsoluteUrl(publicApiBaseUrl, floorplan?.image?.url);
  if (imageUrl) {
    cards.push({
      type: "picture",
      image: imageUrl,
      title: `${floorplan.name} 户型图`,
      tap_action: { action: "none" },
      hold_action: { action: "none" }
    });
  }

  const roomLines = (floorplan.rooms || []).map((room) => {
    const roomId = String(room?.id || "").trim();
    const count = roomDeviceCounts.get(roomId) || 0;
    return `- ${room.name} (${count} 台设备)`;
  });
  if (roomDeviceCounts.get("__unassigned__")) {
    roomLines.push(`- 未分配房间 (${roomDeviceCounts.get("__unassigned__")} 台设备)`);
  }
  cards.push({
    type: "markdown",
    title: "房间 / Areas",
    content: roomLines.length ? roomLines.join("\n") : "暂无同步房间。"
  });

  cards.push(
    entities.length
      ? {
          type: "entities",
          title: "设备 / HA Entities",
          entities
        }
      : {
          type: "markdown",
          title: "设备 / HA Entities",
          content: "当前户型没有可映射到 Home Assistant 的设备。"
        }
  );

  if (sceneButtons.length) {
    cards.push({
      type: "grid",
      title: "场景 / Scenes",
      square: false,
      columns: 2,
      cards: sceneButtons
    });
  }

  if (scriptButtons.length) {
    cards.push({
      type: "grid",
      title: "脚本 / Scripts",
      square: false,
      columns: 2,
      cards: scriptButtons
    });
  }

  if (!sceneButtons.length && !scriptButtons.length) {
    cards.push({
      type: "markdown",
      title: "场景 / Scripts",
      content: "当前户型没有带 floorplan scope 的可同步场景。"
    });
  }

  return {
    title: floorplan.name,
    views: [
      {
        title: floorplan.name,
        path: "overview",
        cards
      }
    ]
  };
}

export function buildGeneratedSceneEntries({ scenes, devices }) {
  const deviceMap = new Map((devices || []).map((device) => [device.id, device]));
  const out = [];

  for (const scene of scenes || []) {
    if (!getSceneScopeFloorplanIds(scene).length) continue;
    const entities = buildHaSceneEntities(scene, deviceMap);
    if (!entities) continue;
    out.push({
      id: buildManagedSceneKey(scene.id),
      name: scene.name,
      icon: SCENE_ICON,
      entities
    });
  }

  return out;
}

export function buildGeneratedScriptEntries({ scenes }) {
  const out = {};

  for (const scene of scenes || []) {
    if (!getSceneScopeFloorplanIds(scene).length) continue;
    if (isSimpleHaScene(scene)) continue;

    out[buildManagedSceneKey(scene.id)] = {
      alias: scene.name,
      description: scene.description || "",
      icon: isAgenticScene(scene) ? "mdi:robot-outline" : SCRIPT_ICON,
      mode: "single",
      sequence: [
        {
          service: `rest_command.${REST_COMMAND_KEY}`,
          data: {
            scene_id: scene.id,
            mode: isAgenticScene(scene) ? "agentic" : "classic"
          }
        }
      ]
    };
  }

  return out;
}

export function mergeManagedSceneList(existing, generated) {
  if (existing === null || existing === undefined || existing === "") return [...generated];
  if (!Array.isArray(existing)) {
    throw new Error("scenes.yaml must be a YAML list");
  }
  const preserved = existing.filter((entry) => !isManagedValue(entry?.id));
  return [...preserved, ...generated];
}

export function mergeManagedNamedEntries(existing, generated, label) {
  if (existing === null || existing === undefined || existing === "") return { ...generated };
  if (!isPlainObject(existing)) {
    throw new Error(`${label} must be a YAML mapping`);
  }
  const merged = {};
  for (const [key, value] of Object.entries(existing)) {
    if (isManagedValue(key)) continue;
    merged[key] = value;
  }
  return { ...merged, ...generated };
}

async function syncGeneratedHaFiles({ homeAssistantConfigDir, publicApiBaseUrl, internalApiBaseUrl, apiKey, floorplans, scenes, devices }) {
  await assertHomeAssistantConfig(homeAssistantConfigDir);
  const scenesPath = path.join(homeAssistantConfigDir, "scenes.yaml");
  const scriptsPath = path.join(homeAssistantConfigDir, "scripts.yaml");
  const restCommandsPath = path.join(homeAssistantConfigDir, "rest_commands.yaml");

  const generatedScenes = buildGeneratedSceneEntries({ scenes, devices });
  const generatedScripts = buildGeneratedScriptEntries({ scenes });
  const restCommands = buildRestCommandsConfig({ internalApiBaseUrl, apiKey });

  const existingScenes = await readYamlFile(scenesPath);
  const existingScripts = await readYamlFile(scriptsPath);
  const existingRestCommands = await readYamlFile(restCommandsPath);

  await Promise.all([
    writeYamlFile(scenesPath, mergeManagedSceneList(existingScenes, generatedScenes)),
    writeYamlFile(scriptsPath, mergeManagedNamedEntries(existingScripts, generatedScripts, "scripts.yaml")),
    writeYamlFile(restCommandsPath, mergeManagedNamedEntries(existingRestCommands, restCommands, "rest_commands.yaml"))
  ]);

  const sceneEntityIdsBySceneId = {};
  const scriptEntityIdsBySceneId = {};
  for (const scene of scenes || []) {
    if (!getSceneScopeFloorplanIds(scene).length) continue;
    if (isSimpleHaScene(scene)) {
      sceneEntityIdsBySceneId[scene.id] = `scene.${buildManagedSceneKey(scene.id)}`;
    } else {
      scriptEntityIdsBySceneId[scene.id] = `script.${buildManagedSceneKey(scene.id)}`;
    }
  }

  return {
    floorplans: floorplans.length,
    publicApiBaseUrl,
    sceneCount: generatedScenes.length,
    scriptCount: Object.keys(generatedScripts).length,
    sceneEntityIdsBySceneId,
    scriptEntityIdsBySceneId
  };
}

async function reconcileFloors({ ws, floorplans, existingFloors }) {
  const desiredAliases = new Set();
  const entriesByFloorplanId = new Map();
  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (let index = 0; index < floorplans.length; index++) {
    const floorplan = floorplans[index];
    const alias = buildFloorplanAlias(floorplan.id);
    desiredAliases.add(alias);
    const existing = findByAlias(existingFloors, alias);
    const payload = {
      name: floorplan.name,
      aliases: uniqueStrings([...(existing?.aliases || []), alias]),
      icon: DASHBOARD_ICON,
      level: index
    };

    if (!existing) {
      const createdEntry = await ws.call("config/floor_registry/create", payload);
      entriesByFloorplanId.set(floorplan.id, createdEntry);
      existingFloors.push(createdEntry);
      created += 1;
      continue;
    }

    const needsUpdate =
      existing.name !== payload.name ||
      existing.icon !== payload.icon ||
      existing.level !== payload.level ||
      !arrayIncludes(existing.aliases, alias);
    if (needsUpdate) {
      const updatedEntry = await ws.call("config/floor_registry/update", {
        floor_id: existing.floor_id,
        ...payload
      });
      entriesByFloorplanId.set(floorplan.id, updatedEntry);
      replaceEntry(existingFloors, existing, updatedEntry, "floor_id");
      updated += 1;
    } else {
      entriesByFloorplanId.set(floorplan.id, existing);
    }
  }

  for (const floor of [...existingFloors]) {
    const managed = getManagedAliasValue(floor?.aliases, FLOORPLAN_ALIAS_PREFIX);
    if (!managed) continue;
    if (desiredAliases.has(managed)) continue;
    await ws.call("config/floor_registry/delete", { floor_id: floor.floor_id });
    deleted += 1;
  }

  return { entriesByFloorplanId, created, updated, deleted };
}

async function reconcileAreas({ ws, floorplans, floorEntriesByFloorplanId, existingAreas }) {
  const desiredAliases = new Set();
  const entriesByRoomKey = new Map();
  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const floorplan of floorplans) {
    const floorEntry = floorEntriesByFloorplanId.get(floorplan.id);
    const floorId = floorEntry?.floor_id || null;
    for (const room of floorplan.rooms || []) {
      const roomKey = buildRoomKey(floorplan.id, room.id);
      const alias = buildRoomAlias(roomKey);
      desiredAliases.add(alias);
      const existing = findByAlias(existingAreas, alias);
      const payload = {
        name: room.name,
        aliases: uniqueStrings([...(existing?.aliases || []), alias]),
        floor_id: floorId
      };

      if (!existing) {
        const createdEntry = await ws.call("config/area_registry/create", payload);
        entriesByRoomKey.set(roomKey, createdEntry);
        existingAreas.push(createdEntry);
        created += 1;
        continue;
      }

      const needsUpdate =
        existing.name !== payload.name ||
        (existing.floor_id || null) !== payload.floor_id ||
        !arrayIncludes(existing.aliases, alias);
      if (needsUpdate) {
        const updatedEntry = await ws.call("config/area_registry/update", {
          area_id: existing.area_id,
          ...payload
        });
        entriesByRoomKey.set(roomKey, updatedEntry);
        replaceEntry(existingAreas, existing, updatedEntry, "area_id");
        updated += 1;
      } else {
        entriesByRoomKey.set(roomKey, existing);
      }
    }
  }

  for (const area of [...existingAreas]) {
    const managed = getManagedAliasValue(area?.aliases, ROOM_ALIAS_PREFIX);
    if (!managed) continue;
    if (desiredAliases.has(managed)) continue;
    await ws.call("config/area_registry/delete", { area_id: area.area_id });
    deleted += 1;
  }

  return { entriesByRoomKey, created, updated, deleted };
}

async function reconcileDeviceAreas({ ws, floorplans, devices, existingDevices, existingEntities, areaEntriesByRoomKey }) {
  const devicesById = new Map((devices || []).map((device) => [device.id, device]));
  const entitiesById = new Map((existingEntities || []).map((entity) => [entity.entity_id, entity]));
  const deviceRegistryById = new Map((existingDevices || []).map((device) => [device.id, device]));
  const desiredAssignments = new Map();
  const managedAreaIds = new Set(Array.from(areaEntriesByRoomKey.values()).map((entry) => entry?.area_id).filter(Boolean));

  for (const floorplan of floorplans || []) {
    for (const entry of floorplan.devices || []) {
      const device = devicesById.get(entry.deviceId);
      const entityId = getHaEntityId(device);
      if (!entityId) continue;
      const roomId = String(entry?.roomId || "").trim();
      const roomKey = roomId ? buildRoomKey(floorplan.id, roomId) : "";
      const areaId = roomKey ? areaEntriesByRoomKey.get(roomKey)?.area_id || null : null;
      desiredAssignments.set(entityId, areaId || null);
    }
  }

  let updated = 0;
  for (const device of devices || []) {
    const entityId = getHaEntityId(device);
    if (!entityId) continue;
    const entityEntry = entitiesById.get(entityId);
    if (!entityEntry) continue;
    const desiredAreaId = desiredAssignments.has(entityId) ? desiredAssignments.get(entityId) : undefined;

    if (entityEntry.device_id) {
      const deviceEntry = deviceRegistryById.get(entityEntry.device_id);
      if (!deviceEntry) continue;
      const currentAreaId = deviceEntry.area_id || null;
      if (desiredAreaId === undefined) {
        if (!managedAreaIds.has(currentAreaId)) continue;
        await ws.call("config/device_registry/update", { device_id: deviceEntry.id, area_id: null });
        updated += 1;
        continue;
      }
      if ((currentAreaId || null) === (desiredAreaId || null)) continue;
      await ws.call("config/device_registry/update", { device_id: deviceEntry.id, area_id: desiredAreaId || null });
      updated += 1;
      continue;
    }

    const currentEntityAreaId = entityEntry.area_id || null;
    if (desiredAreaId === undefined) {
      if (!managedAreaIds.has(currentEntityAreaId)) continue;
      await ws.call("config/entity_registry/update", { entity_id: entityId, area_id: null });
      updated += 1;
      continue;
    }
    if ((currentEntityAreaId || null) === (desiredAreaId || null)) continue;
    await ws.call("config/entity_registry/update", { entity_id: entityId, area_id: desiredAreaId || null });
    updated += 1;
  }

  return { updated };
}

async function reconcileDashboards({ ws, floorplans, devices, scenes, existingDashboards, publicApiBaseUrl, exportOutcome }) {
  const dashboards = [...existingDashboards];
  const desiredPaths = new Set();
  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const floorplan of floorplans) {
    const urlPath = buildManagedDashboardUrlPath(floorplan.id);
    desiredPaths.add(urlPath);
    let dashboard = dashboards.find((entry) => entry?.url_path === urlPath);
    const payload = {
      title: floorplan.name,
      url_path: urlPath,
      icon: DASHBOARD_ICON,
      show_in_sidebar: true,
      require_admin: false
    };

    if (!dashboard) {
      dashboard = await ws.call("lovelace/dashboards/create", payload);
      dashboards.push(dashboard);
      created += 1;
    } else {
      const needsUpdate =
        dashboard.title !== payload.title ||
        dashboard.icon !== payload.icon ||
        dashboard.show_in_sidebar !== payload.show_in_sidebar ||
        dashboard.require_admin !== payload.require_admin;
      if (needsUpdate) {
        dashboard = await ws.call("lovelace/dashboards/update", {
          dashboard_id: dashboard.id,
          title: payload.title,
          icon: payload.icon,
          show_in_sidebar: payload.show_in_sidebar,
          require_admin: payload.require_admin
        });
        replaceEntry(dashboards, dashboards.find((entry) => entry?.url_path === urlPath), dashboard, "id");
        updated += 1;
      }
    }

    await ws.call("lovelace/config/save", {
      url_path: urlPath,
      config: buildFloorplanDashboardConfig({
        floorplan,
        devices,
        scenes,
        publicApiBaseUrl,
        exportOutcome
      })
    });
  }

  for (const dashboard of dashboards) {
    const pathValue = String(dashboard?.url_path || "");
    if (!pathValue.startsWith("smarthouse-")) continue;
    if (desiredPaths.has(pathValue)) continue;
    await ws.call("lovelace/config/delete", { url_path: pathValue }).catch(() => undefined);
    await ws.call("lovelace/dashboards/delete", { dashboard_id: dashboard.id });
    deleted += 1;
  }

  return { created, updated, deleted };
}

function buildHaSceneEntities(scene, deviceMap) {
  if (!isSimpleHaScene(scene)) return null;
  const entities = {};
  for (const step of scene.steps || []) {
    const device = deviceMap.get(step.deviceId);
    const entityId = getHaEntityId(device);
    if (!entityId) return null;
    const state = toHaSceneEntityState(step);
    if (!state) return null;
    entities[entityId] = state;
  }
  return Object.keys(entities).length ? entities : null;
}

function isSimpleHaScene(scene) {
  if (!Array.isArray(scene?.steps) || !scene.steps.length) return false;
  for (const step of scene.steps) {
    if (!step || step.type !== "device") return false;
    if (step.wait_for) return false;
    if (!toHaSceneEntityState(step)) return false;
  }
  return true;
}

function isAgenticScene(scene) {
  return Array.isArray(scene?.intent?.goals) && scene.intent.goals.length > 0;
}

function toHaSceneEntityState(step) {
  const action = String(step?.action || "").trim();
  const params = step?.params || {};
  if (action === "turn_on") return { state: "on" };
  if (action === "turn_off") return { state: "off" };
  if (action === "set_brightness" && Number.isFinite(params.brightness)) {
    return { state: "on", brightness_pct: clamp(Number(params.brightness), 0, 100) };
  }
  if (action === "set_color_temp" && Number.isFinite(params.kelvin)) {
    return { state: "on", color_temp_kelvin: Math.round(Number(params.kelvin)) };
  }
  return null;
}

function buildRestCommandsConfig({ internalApiBaseUrl, apiKey }) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }
  return {
    [REST_COMMAND_KEY]: {
      url: `${stripTrailingSlash(internalApiBaseUrl)}/scenes/{{ scene_id }}/run`,
      method: "POST",
      headers,
      payload: '{"mode":"{{ mode | default(\'classic\') }}","confirm":true}'
    }
  };
}

async function reloadHaDomainService({ baseUrl, token, domain, service }) {
  const url = `${stripTrailingSlash(baseUrl)}/api/services/${domain}/${service}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: "{}"
  });
  if (!response.ok) {
    const message = await safeReadText(response);
    throw new Error(`HA ${domain}.${service} failed: ${response.status} ${message}`.trim());
  }
}

async function readYamlFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return null;
    return YAML.parse(raw);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function writeYamlFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const serialized = YAML.stringify(value);
  await fs.writeFile(tmpPath, serialized, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function assertHomeAssistantConfig(homeAssistantConfigDir) {
  const configurationPath = path.join(homeAssistantConfigDir, "configuration.yaml");
  const raw = await fs.readFile(configurationPath, "utf8");
  if (!raw.includes("rest_command: !include rest_commands.yaml")) {
    throw new Error("Home Assistant configuration.yaml must include rest_command: !include rest_commands.yaml");
  }
}

function buildFloorplanAlias(floorplanId) {
  return `${FLOORPLAN_ALIAS_PREFIX}${encodeURIComponent(String(floorplanId || ""))}`;
}

function buildRoomAlias(roomKey) {
  return `${ROOM_ALIAS_PREFIX}${encodeURIComponent(roomKey)}`;
}

function buildRoomKey(floorplanId, roomId) {
  return `${String(floorplanId || "").trim()}::${String(roomId || "").trim()}`;
}

function getHaEntityId(device) {
  const value = device?.bindings?.ha?.entity_id || device?.bindings?.ha_entity_id;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function slugSegment(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "floorplan";
}

function sanitizeKey(value) {
  const key = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || "scene";
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function toAbsoluteUrl(baseUrl, url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const base = stripTrailingSlash(baseUrl);
  if (!base) return trimmed;
  return `${base}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
}

function buildButtonCard({ name, entityId, service }) {
  return {
    type: "button",
    name,
    icon: entityId.startsWith("scene.") ? SCENE_ICON : SCRIPT_ICON,
    tap_action: {
      action: "call-service",
      service,
      target: {
        entity_id: entityId
      }
    }
  };
}

function getManagedAliasValue(aliases, prefix) {
  for (const value of aliases || []) {
    const alias = String(value || "").trim();
    if (!alias.startsWith(prefix)) continue;
    return alias;
  }
  return "";
}

function findByAlias(entries, alias) {
  return (entries || []).find((entry) => arrayIncludes(entry?.aliases, alias));
}

function arrayIncludes(list, value) {
  return Array.isArray(list) && list.some((entry) => String(entry || "") === String(value || ""));
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const item = String(value || "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function replaceEntry(list, previous, next, key) {
  const index = list.findIndex((entry) => entry?.[key] === previous?.[key]);
  if (index >= 0) {
    list[index] = next;
  }
}

function isManagedValue(value) {
  return String(value || "").startsWith(MANAGED_PREFIX);
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (_err) {
    return "";
  }
}

class HomeAssistantWsClient {
  constructor({ baseUrl, token, logger }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.logger = logger;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (this.ws) return;
    const wsUrl = buildWsUrl(this.baseUrl);
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        ws.off("message", onMessage);
        ws.off("error", onError);
        ws.off("close", onClose);
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const onClose = (code, reason) => {
        cleanup();
        reject(new Error(`ha_ws_closed ${code} ${String(reason || "")}`));
      };
      const onMessage = (data) => {
        const message = parseJson(data);
        if (!message) return;
        if (message.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: this.token }));
          return;
        }
        if (message.type === "auth_invalid") {
          cleanup();
          reject(new Error(message.message || "ha_ws_auth_invalid"));
          return;
        }
        if (message.type === "auth_ok") {
          cleanup();
          ws.on("message", (event) => this.#onMessage(event));
          ws.on("close", (code, reason) => this.#onClose(code, reason));
          ws.on("error", (err) => this.#onError(err));
          resolve();
        }
      };

      ws.on("message", onMessage);
      ws.on("error", onError);
      ws.on("close", onClose);
    });
  }

  async call(type, payload = {}) {
    await this.connect();
    const id = this.nextId++;
    const body = { id, type, ...payload };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ha_ws_timeout ${type}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
    this.ws.send(JSON.stringify(body));
    return promise;
  }

  async close() {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("ha_ws_closed"));
    }
    this.pending.clear();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      await new Promise((resolve) => {
        ws.once("close", resolve);
        ws.close(1000);
      }).catch(() => undefined);
    }
  }

  #onMessage(data) {
    const message = parseJson(data);
    if (!message) return;
    if (message.type === "ping") {
      this.ws?.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (message.type !== "result") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.success) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.error?.message || `ha_ws_error ${message.error?.code || "unknown"}`));
  }

  #onClose(code, reason) {
    const error = new Error(`ha_ws_closed ${code} ${String(reason || "")}`);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  #onError(err) {
    this.logger?.warn?.("ha.ws.error", { message: err?.message || String(err) });
  }
}

function buildWsUrl(baseUrl) {
  const url = new URL(stripTrailingSlash(baseUrl));
  const protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${url.host}/api/websocket`;
}

function parseJson(data) {
  try {
    return JSON.parse(typeof data === "string" ? data : data?.toString?.("utf8") || "");
  } catch (_err) {
    return null;
  }
}
