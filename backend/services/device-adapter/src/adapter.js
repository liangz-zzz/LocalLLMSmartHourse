import fs from "fs/promises";
import path from "path";
import mqtt from "mqtt";
import { normalizeZigbee2Mqtt } from "./normalize.js";
import { buildActionResult } from "./action-results.js";
import { applyDeviceOverrides, loadDeviceOverrides, loadVoiceControlConfig } from "./device-config.js";
import { connectHaStateSubscription, fetchHaStates, normalizeHomeAssistantEntity, shouldIncludeHaEntity } from "./ha.js";
import { createCommandVoiceRuntime, executeVoiceControlAction } from "./voice-control.js";

export class DeviceAdapter {
  constructor({
    mode,
    mqttUrl,
    store,
    mockDataDir,
    deviceConfigPath,
    logger,
    haBaseUrl,
    haToken,
    actionTransport,
    haIncludeDomains,
    haExcludeDomains,
    haWsEnabled,
    haPollIntervalMs,
    deviceOverridesPollMs,
    voiceTtsCommand,
    voiceSttCommand,
    voiceAckKeywords,
    voiceMicMaxDistance,
    voiceCommandTimeoutMs,
    voiceRuntime,
    voiceControlConfig
  }) {
    this.mode = mode;
    this.mqttUrl = mqttUrl;
    this.store = store;
    this.mockDataDir = mockDataDir;
    this.deviceConfigPath = deviceConfigPath;
    this.logger = logger;
    this.client = null;
    this.haBaseUrl = haBaseUrl;
    this.haToken = haToken;
    this.actionTransport = actionTransport || "auto";
    this.haIncludeDomains = haIncludeDomains || ["switch", "light", "cover", "climate"];
    this.haExcludeDomains = haExcludeDomains || [];
    this.haWsEnabled = haWsEnabled !== false;
    this.haPollIntervalMs = haPollIntervalMs || 0;
    this.haPollTimer = null;
    this.haWs = null;
    this.haWsStop = null;
    this.haStopping = false;
    this.haReconnectAttempt = 0;
    this.deviceOverrides = new Map();
    const envVoiceConfig = normalizeVoiceControlConfig({
      defaults: { ack_keywords: Array.isArray(voiceAckKeywords) ? voiceAckKeywords : [] },
      mic_selection: {
        mode: "nearest_static",
        max_distance: Number.isFinite(Number(voiceMicMaxDistance)) ? Number(voiceMicMaxDistance) : undefined
      },
      mics: []
    });
    this.voiceControlConfig = mergeVoiceControlConfig(envVoiceConfig, voiceControlConfig);
    this.voiceRuntime =
      voiceRuntime ||
      createCommandVoiceRuntime({
        ttsCommand: voiceTtsCommand,
        sttCommand: voiceSttCommand,
        commandTimeoutMs: voiceCommandTimeoutMs,
        logger: this.logger
      });
    this.deviceOverridesPollMs = Number.isFinite(deviceOverridesPollMs) ? Math.floor(deviceOverridesPollMs) : 2000;
    this.deviceOverridesPollTimer = null;
    this.deviceOverridesLastMtimeMs = null;
    this.deviceOverridesRefreshing = false;
    this.deviceOverridesResolvedPath = "";
  }

  async start() {
    this.deviceOverridesResolvedPath = resolveFsPath(this.deviceConfigPath);
    this.deviceOverridesLastMtimeMs = await getMtimeMs(this.deviceOverridesResolvedPath);
    this.deviceOverrides = await loadDeviceOverrides(this.deviceConfigPath, this.logger);
    const loadedVoiceConfig = await loadVoiceControlConfig(this.deviceConfigPath, this.logger);
    this.voiceControlConfig = mergeVoiceControlConfig(this.voiceControlConfig, loadedVoiceConfig);
    this.startDeviceOverridesPolling();
    if (this.mode === "offline") {
      this.logger.info("Starting adapter in offline mode (mock data)");
      return this.loadMockData();
    }
    if (this.mode === "mqtt") {
      this.logger.info("Starting adapter in mqtt mode", this.mqttUrl);
      return this.startMqtt();
    }
    if (this.mode === "ha") {
      this.logger.info("Starting adapter in Home Assistant mode", this.haBaseUrl);
      return this.startHa();
    }
    throw new Error(`Unsupported mode: ${this.mode}`);
  }

  async stop() {
    this.haStopping = true;
    if (this.deviceOverridesPollTimer) {
      clearInterval(this.deviceOverridesPollTimer);
      this.deviceOverridesPollTimer = null;
    }
    if (this.haPollTimer) {
      clearInterval(this.haPollTimer);
      this.haPollTimer = null;
    }
    if (this.haWsStop) {
      try {
        await this.haWsStop();
      } finally {
        this.haWsStop = null;
        this.haWs = null;
      }
    }
    if (this.client) {
      await new Promise((resolve) => this.client.end(false, {}, resolve));
      this.client = null;
    }
  }

  startDeviceOverridesPolling() {
    if (!this.deviceOverridesPollMs || this.deviceOverridesPollMs <= 0) return;
    if (this.deviceOverridesPollTimer) return;
    this.deviceOverridesPollTimer = setInterval(() => {
      this.refreshDeviceOverridesIfChanged().catch((err) => {
        this.logger?.warn?.("device overrides refresh failed", err?.message || String(err));
      });
    }, this.deviceOverridesPollMs);
  }

  async refreshDeviceOverridesIfChanged() {
    if (!this.deviceOverridesResolvedPath) return;
    if (this.deviceOverridesRefreshing) return;
    this.deviceOverridesRefreshing = true;
    try {
      const mtimeMs = await getMtimeMs(this.deviceOverridesResolvedPath);
      if (mtimeMs === this.deviceOverridesLastMtimeMs) return;
      this.deviceOverridesLastMtimeMs = mtimeMs;
      this.deviceOverrides = await loadDeviceOverrides(this.deviceConfigPath, this.logger);
      const loadedVoiceConfig = await loadVoiceControlConfig(this.deviceConfigPath, this.logger);
      this.voiceControlConfig = mergeVoiceControlConfig(this.voiceControlConfig, loadedVoiceConfig);
      const devices = await this.store.list();
      for (const device of devices) {
        const override = this.deviceOverrides.get(device.id);
        const normalized = applyDeviceOverrides({ base: device, existing: null, override });
        await this.store.upsert(normalized);
      }
    } finally {
      this.deviceOverridesRefreshing = false;
    }
  }

  async handleAction(action) {
    // Expected shape: { id, action, params }
    if (!this.store) return;
    const device = await this.store.get(action.id);
    if (!device) {
      this.logger.warn("Action ignored, device not found", action.id);
      return;
    }

    const hasZ2M = device.bindings?.zigbee2mqtt?.topic && this.client;
    const haEntity = device.bindings?.ha?.entity_id || device.bindings?.ha_entity_id;
    const hasVoice = Boolean(device.bindings?.voice_control);
    const preferHa = this.actionTransport === "ha";
    const preferMqtt = this.actionTransport === "mqtt";
    const forceVoice = this.actionTransport === "voice";
    const preferVoice = device.bindings?.voice_control?.priority === "prefer";

    if (forceVoice) {
      if (!hasVoice) {
        await this.store.publishActionResult?.(
          buildActionResult({
            deviceId: device.id,
            action: action.action,
            status: "error",
            transport: "voice",
            params: action.params,
            reason: "voice_binding_missing"
          })
        );
        return;
      }
      await this.handleVoiceAction({ device, action });
      return;
    }

    if (preferVoice && hasVoice) {
      await this.handleVoiceAction({ device, action });
      return;
    }

    if (!preferHa && hasZ2M) {
      const topic = `${device.bindings.zigbee2mqtt.topic}/set`;
      const payload = buildZ2MSetPayload(action);
      this.logger.info("Publishing action to MQTT", topic, payload, { actor: action.actor });
      this.client.publish(topic, JSON.stringify(payload));
      await this.store.publishActionResult?.(
        buildActionResult({ deviceId: device.id, action: action.action, status: 'ok', transport: 'mqtt', params: action.params })
      );
      return;
    }

    if (!preferMqtt && haEntity && this.haToken) {
      const result = await callHaService({
        baseUrl: this.haBaseUrl,
        token: this.haToken,
        entityId: haEntity,
        action,
        params: action.params || {},
        logger: this.logger
      });
      await this.store.publishActionResult?.(
        buildActionResult({
          deviceId: device.id,
          action: action.action,
          status: result.ok ? 'ok' : 'error',
          transport: 'ha',
          params: action.params,
          reason: result.reason
        })
      );
      return;
    }

    if (hasVoice) {
      await this.handleVoiceAction({ device, action });
      return;
    }

    this.logger.warn("No delivery path for action", action);
    await this.store.publishActionResult?.(
      buildActionResult({
        deviceId: device.id,
        action: action.action,
        status: 'error',
        transport: 'none',
        params: action.params,
        reason: 'no_delivery_path'
      })
    );
  }

  async handleVoiceAction({ device, action }) {
    const result = await executeVoiceControlAction({
      device,
      actionName: action.action,
      params: action.params || {},
      voiceBinding: device.bindings?.voice_control,
      voiceConfig: this.voiceControlConfig,
      runtime: this.voiceRuntime,
      logger: this.logger
    });

    if (result.ok) {
      await this.store.publishActionResult?.(
        buildActionResult({
          deviceId: device.id,
          action: action.action,
          status: "ok",
          transport: "voice",
          params: action.params,
          details: {
            ...result.details,
            voice_risk: device.bindings?.voice_control?.actions?.[action.action]?.risk
          }
        })
      );
      return;
    }

    this.logger.warn("Voice action blocked", {
      deviceId: device.id,
      action: action.action,
      reason: result.reason,
      errorCode: result.errorCode
    });
    await this.store.publishActionResult?.(
      buildActionResult({
        deviceId: device.id,
        action: action.action,
        status: "error",
        transport: "voice",
        params: action.params,
        reason: result.reason || result.errorCode || "voice_action_failed",
        errorCode: result.errorCode,
        details: result.details
      })
    );
  }

  async loadMockData() {
    const devicePath = path.join(new URL(this.mockDataDir).pathname, "device.json");
    const statePath = path.join(new URL(this.mockDataDir).pathname, "state.json");
    const [device, state] = await Promise.all([readJson(devicePath), readJson(statePath)]);
    const base = normalizeZigbee2Mqtt({ device, state, placement: this.deviceOverrides.get(device?.friendly_name)?.placement });
    const normalized = applyDeviceOverrides({ base, existing: null, override: this.deviceOverrides.get(base.id) });
    await this.store.upsert(normalized);
    this.logger.info("Loaded mock device", normalized.id);
  }

  async startHa() {
    if (!this.haToken) {
      throw new Error("HA_TOKEN is required for MODE=ha");
    }

    await this.syncHaOnce();

    if (this.haWsEnabled) {
      await this.connectHaWsWithRetry();
    }

    if (this.haPollIntervalMs > 0) {
      this.haPollTimer = setInterval(() => {
        this.syncHaOnce().catch((err) => this.logger.warn("HA poll failed", err?.message || String(err)));
      }, this.haPollIntervalMs);
    }
  }

  async syncHaOnce() {
    const states = await fetchHaStates({ baseUrl: this.haBaseUrl, token: this.haToken });
    const list = Array.isArray(states) ? states : [];
    this.logger.info("Received HA states", list.length);
    for (const st of list) {
      const entityId = st?.entity_id;
      if (!shouldIncludeHaEntity({ entityId, includeDomains: this.haIncludeDomains, excludeDomains: this.haExcludeDomains })) continue;
      await this.upsertHaEntity(st);
    }
  }

  async upsertHaEntity(state) {
    const entityId = state?.entity_id;
    if (!entityId) return;
    const existing = await this.store.get(entityId);
    const override = this.deviceOverrides.get(entityId);
    const base = normalizeHomeAssistantEntity({
      state,
      placement: override?.placement || existing?.placement
    });
    const normalized = applyDeviceOverrides({ base, existing, override });
    await this.store.upsert(normalized);
  }

  async connectHaWsWithRetry() {
    while (!this.haStopping) {
      try {
        await this.connectHaWs();
        this.haReconnectAttempt = 0;
        return;
      } catch (err) {
        this.haReconnectAttempt += 1;
        const delayMs = Math.min(30_000, 500 * Math.pow(2, Math.min(this.haReconnectAttempt, 6)));
        this.logger.warn("HA websocket connect failed, will retry", { attempt: this.haReconnectAttempt, delayMs, error: err?.message || String(err) });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async connectHaWs() {
    if (this.haWsStop) {
      await this.haWsStop();
      this.haWsStop = null;
      this.haWs = null;
    }
    this.haStopping = false;

    const { ws, stop } = await connectHaStateSubscription({
      baseUrl: this.haBaseUrl,
      token: this.haToken,
      logger: this.logger,
      onStateChanged: async (newState) => {
        try {
          if (!newState?.entity_id) return;
          if (!shouldIncludeHaEntity({ entityId: newState.entity_id, includeDomains: this.haIncludeDomains, excludeDomains: this.haExcludeDomains })) return;
          await this.upsertHaEntity(newState);
        } catch (err) {
          this.logger.warn("Failed to handle HA state_changed", err?.message || String(err));
        }
      },
      onDisconnected: async () => {
        if (this.haStopping) return;
        this.logger.warn("HA websocket disconnected, reconnecting");
        await this.connectHaWsWithRetry();
      }
    });

    this.haWs = ws;
    this.haWsStop = stop;
  }

  startMqtt() {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect(this.mqttUrl);
      this.client = client;

      client.on("connect", () => {
        this.logger.info("MQTT connected", this.mqttUrl);
        client.subscribe(["zigbee2mqtt/bridge/devices", "zigbee2mqtt/+/availability", "zigbee2mqtt/+"]);
        resolve();
      });

      client.on("error", (err) => {
        this.logger.error("MQTT error", err);
        reject(err);
      });

      client.on("message", async (topic, payload) => {
        try {
          if (topic === "zigbee2mqtt/bridge/devices") {
            const devices = parseJson(payload);
            if (Array.isArray(devices)) {
              this.logger.info("Received device list", devices.length);
              // we only store bindings now; state will come from per-device topics
              for (const dev of devices) {
                const id = dev?.friendly_name || dev?.ieee_address || "unknown_device";
                const existing = await this.store.get(id);
                const override = this.deviceOverrides.get(id);
                const base = normalizeZigbee2Mqtt({ device: dev, state: {}, placement: override?.placement || existing?.placement });
                const normalized = applyDeviceOverrides({ base, existing, override });
                await this.store.upsert(normalized);
              }
            }
            return;
          }

          const match = topic.match(/^zigbee2mqtt\/([^/]+)$/);
          if (match) {
            const friendly = match[1];
            const state = parseJson(payload);
            const existing = await this.store.get(friendly);
            const deviceMeta = existing?.bindings?.zigbee2mqtt || { friendly_name: friendly };
            const override = this.deviceOverrides.get(friendly);
            const base = normalizeZigbee2Mqtt({ device: deviceMeta, state, placement: override?.placement || existing?.placement });
            const normalized = applyDeviceOverrides({ base, existing, override });
            await this.store.upsert(normalized);
            this.logger.debug("Updated state", friendly);
          }
        } catch (err) {
          this.logger.error("Failed to handle MQTT message", err);
        }
      });
    });
  }
}

function parseJson(buf) {
  try {
    return JSON.parse(buf.toString());
  } catch (_e) {
    return undefined;
  }
}

async function readJson(p) {
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw);
}

function buildZ2MSetPayload(action) {
  if (action.action === "turn_on") return { state: "ON" };
  if (action.action === "turn_off") return { state: "OFF" };
  if (action.action === "set_brightness") {
    const b = action.params?.brightness ?? action.params?.level;
    return { state: "ON", brightness: b ?? 254 };
  }
  if (action.action === "set_cover_position") {
    const pos = action.params?.position;
    return { position: pos ?? 0 };
  }
  if (action.action === "set_cover_tilt") {
    const tilt = action.params?.tilt ?? action.params?.tilt_percent;
    return { tilt: tilt ?? 0 };
  }
  if (action.action === "set_color_temp") {
    const kelvin = action.params?.kelvin ?? action.params?.color_temp_kelvin;
    const mired = action.params?.mired;
    if (mired !== undefined) return { color_temp: mired };
    if (kelvin !== undefined) return { color_temp: Math.round(1000000 / kelvin) };
    return { color_temp: 350 };
  }
  if (action.action === "set_temperature") {
    const t = action.params?.temperature ?? action.params?.target_temperature;
    return { temperature: t ?? 22 };
  }
  if (action.action === "set_hvac_mode") {
    const mode = action.params?.mode || "auto";
    return { state: "ON", fan_mode: mode, mode };
  }
  return { state: "TOGGLE" };
}

function resolveFsPath(p) {
  const raw = String(p || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

async function getMtimeMs(resolvedPath) {
  if (!resolvedPath) return null;
  try {
    const st = await fs.stat(resolvedPath);
    return st.mtimeMs;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function mergeVoiceControlConfig(base, incoming) {
  const baseCfg = normalizeVoiceControlConfig(base);
  const nextCfg = normalizeVoiceControlConfig(incoming);
  const ackKeywords = nextCfg.defaults.ack_keywords.length ? nextCfg.defaults.ack_keywords : baseCfg.defaults.ack_keywords;
  const maxDistance =
    nextCfg.mic_selection.max_distance !== undefined ? nextCfg.mic_selection.max_distance : baseCfg.mic_selection.max_distance;
  return {
    defaults: {
      ack_keywords: ackKeywords
    },
    mic_selection: {
      mode: String(nextCfg.mic_selection.mode || baseCfg.mic_selection.mode || "nearest_static"),
      max_distance: maxDistance
    },
    mics: nextCfg.mics.length ? nextCfg.mics : baseCfg.mics
  };
}

function normalizeVoiceControlConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const defaultsRaw = cfg.defaults && typeof cfg.defaults === "object" ? cfg.defaults : {};
  const micSelectionRaw = cfg.mic_selection && typeof cfg.mic_selection === "object" ? cfg.mic_selection : {};
  return {
    defaults: {
      ack_keywords: uniqStrings(defaultsRaw.ack_keywords || [])
    },
    mic_selection: {
      mode: String(micSelectionRaw.mode || "nearest_static"),
      max_distance: toFiniteNumber(micSelectionRaw.max_distance)
    },
    mics: Array.isArray(cfg.mics) ? cfg.mics.filter((mic) => mic && String(mic.id || "").trim()) : []
  };
}

function uniqStrings(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const s = String(item || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function callHaService({ baseUrl, token, entityId, action, params, logger }) {
  const domain = entityId.split(".")[0];
  let service = action.action === "turn_off" ? "turn_off" : "turn_on";
  let payload = { entity_id: entityId };

  if (action.action === "set_brightness") {
    service = "turn_on";
    const pct = typeof params?.brightness === "number" ? params.brightness : undefined;
    payload = { entity_id: entityId, brightness_pct: pct ?? 100 };
  } else if (action.action === "toggle") {
    service = "toggle";
  } else if (action.action === "set_cover_position") {
    service = "set_cover_position";
    const pos = typeof params?.position === "number" ? params.position : undefined;
    payload = { entity_id: entityId, position: pos ?? 0 };
  } else if (action.action === "set_cover_tilt") {
    service = "set_cover_tilt_position";
    const tilt = typeof params?.tilt === "number" ? params.tilt : params?.tilt_percent;
    payload = { entity_id: entityId, tilt_position: tilt ?? 0 };
  } else if (action.action === "set_temperature") {
    service = "set_temperature";
    const t = typeof params?.temperature === "number" ? params.temperature : params?.target_temperature;
    payload = { entity_id: entityId, temperature: t ?? 22 };
  } else if (action.action === "set_hvac_mode") {
    service = "set_hvac_mode";
    payload = { entity_id: entityId, hvac_mode: params?.mode || "auto" };
  } else if (action.action === "set_fan_mode") {
    service = "set_fan_mode";
    payload = { entity_id: entityId, fan_mode: params?.fan_mode || params?.mode || "auto" };
  } else if (action.action === "set_color_temp") {
    service = "turn_on";
    const kelvin = typeof params?.kelvin === "number" ? params.kelvin : params?.color_temp_kelvin;
    const mired = typeof params?.mired === "number" ? params.mired : undefined;
    payload = { entity_id: entityId };
    if (kelvin) payload.color_temp_kelvin = kelvin;
    if (mired) payload.color_temp = mired;
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/services/${domain}/${service}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      logger?.warn?.("HA service call failed", res.status, text);
      return { ok: false, reason: `${res.status} ${text}` };
    }
    logger?.info?.("HA service called", url);
    return { ok: true };
  } catch (err) {
    logger?.error?.("HA service call error", err);
    return { ok: false, reason: err.message };
  }
}
