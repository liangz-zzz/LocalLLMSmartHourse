import WebSocket from "ws";

export async function fetchHaStates({ baseUrl, token }) {
  const url = `${stripTrailingSlash(baseUrl)}/api/states`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(`HA /api/states failed: ${res.status} ${text}`);
  }
  return res.json();
}

export function shouldIncludeHaEntity({ entityId, includeDomains, excludeDomains }) {
  if (!entityId) return false;
  const domain = String(entityId).split(".")[0];
  if (!domain) return false;
  if (Array.isArray(excludeDomains) && excludeDomains.includes(domain)) return false;
  if (Array.isArray(includeDomains) && includeDomains.length) {
    return includeDomains.includes(domain);
  }
  return true;
}

export function normalizeHomeAssistantEntity({ state, placement }) {
  const entityId = state?.entity_id || "unknown_entity";
  const domain = entityId.split(".")[0] || "unknown";
  const attrs = state?.attributes || {};
  const friendlyName = attrs?.friendly_name || entityId;

  const base = {
    id: entityId,
    name: String(friendlyName),
    placement: placement || {
      room: "unknown_room",
      description: "placeholder placement; provide real room/zone when available"
    },
    protocol: "virtual",
    bindings: {
      ha: {
        entity_id: entityId
      }
    },
    traits: buildHaTraits(domain, state),
    capabilities: buildHaCapabilities(domain, state),
    semantics: {
      tags: uniqStrings(["ha", domain, attrs?.device_class, attrs?.icon]),
      device_class: attrs?.device_class,
      unit: attrs?.unit_of_measurement
    }
  };

  // Cleanup empty fields
  if (!base.semantics.tags?.length) delete base.semantics.tags;
  if (!base.semantics.device_class) delete base.semantics.device_class;
  if (!base.semantics.unit) delete base.semantics.unit;
  if (!Object.keys(base.semantics).length) delete base.semantics;
  return base;
}

export async function connectHaStateSubscription({ baseUrl, token, logger, onStateChanged, onDisconnected }) {
  const wsUrl = buildHaWsUrl(baseUrl);
  const ws = new WebSocket(wsUrl);
  let ready = false;
  let closing = false;
  const subId = 1;

  const stop = async () => {
    closing = true;
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000);
      await new Promise((resolve) => ws.once("close", resolve));
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  };

  const readyPromise = new Promise((resolve, reject) => {
    const fail = (err) => {
      if (ready) return;
      ready = true;
      reject(err);
    };

    ws.once("error", (err) => fail(err));
  ws.once("close", (code, reason) => {
      if (!ready) fail(new Error(`ha_ws_closed_before_ready ${code} ${String(reason || "")}`));
    });

    ws.on("message", (data) => {
      const msg = safeParseJson(data);
      if (!msg) return;

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
        return;
      }

      if (msg.type === "auth_invalid") {
        fail(new Error("ha_ws_auth_invalid"));
        return;
      }

      if (msg.type === "auth_ok") {
        ws.send(JSON.stringify({ id: subId, type: "subscribe_events", event_type: "state_changed" }));
        return;
      }

      if (msg.type === "result" && msg.id === subId) {
        if (!msg.success) {
          fail(new Error("ha_ws_subscribe_failed"));
          return;
        }
        if (!ready) {
          ready = true;
          logger?.info?.("HA websocket subscribed", { wsUrl, subId });
          resolve();
        }
        return;
      }

      if (msg.type === "event" && msg.id === subId) {
        const newState = msg?.event?.data?.new_state;
        if (newState) onStateChanged?.(newState);
      }
    });
  });

  await readyPromise;

  ws.on("close", (code, reason) => {
    if (closing) return;
    logger?.warn?.("HA websocket closed", { code, reason: String(reason || "") });
    onDisconnected?.();
  });

  ws.on("error", (err) => {
    if (closing) return;
    logger?.warn?.("HA websocket error", err?.message || String(err));
  });

  return { ws, stop };
}

function buildHaCapabilities(domain, state) {
  const attrs = state?.attributes || {};

  if (domain === "switch") {
    return [
      { action: "turn_on", description: "打开" },
      { action: "turn_off", description: "关闭" },
      { action: "toggle", description: "切换" }
    ];
  }

  if (domain === "light") {
    const caps = [
      { action: "turn_on", description: "开灯" },
      { action: "turn_off", description: "关灯" },
      { action: "toggle", description: "切换" }
    ];
    const hasBrightness = typeof attrs?.brightness === "number";
    if (hasBrightness) {
      caps.push({
        action: "set_brightness",
        parameters: [{ name: "brightness", type: "number", minimum: 0, maximum: 100, required: true }],
        description: "设置亮度"
      });
    }
    const hasColorTemp =
      typeof attrs?.color_temp_kelvin === "number" ||
      typeof attrs?.color_temp === "number" ||
      typeof attrs?.min_mireds === "number" ||
      typeof attrs?.max_mireds === "number" ||
      (Array.isArray(attrs?.supported_color_modes) && attrs.supported_color_modes.includes("color_temp"));
    if (hasColorTemp) {
      const { minKelvin, maxKelvin } = deriveKelvinRange(attrs);
      caps.push({
        action: "set_color_temp",
        parameters: [{ name: "kelvin", type: "number", minimum: minKelvin, maximum: maxKelvin, required: true }],
        description: "设置色温（开尔文）"
      });
    }
    return caps;
  }

  if (domain === "cover") {
    const caps = [
      {
        action: "set_cover_position",
        parameters: [{ name: "position", type: "number", minimum: 0, maximum: 100, required: true }],
        description: "设置开合比例"
      }
    ];
    const tilt = attrs?.current_tilt_position ?? attrs?.tilt_position;
    if (typeof tilt === "number") {
      caps.push({
        action: "set_cover_tilt",
        parameters: [{ name: "tilt", type: "number", minimum: 0, maximum: 100, required: true }],
        description: "设置翻转角度（百分比）"
      });
    }
    return caps;
  }

  if (domain === "climate") {
    const caps = [];
    const minTemp = typeof attrs?.min_temp === "number" ? attrs.min_temp : 5;
    const maxTemp = typeof attrs?.max_temp === "number" ? attrs.max_temp : 35;
    caps.push({
      action: "set_temperature",
      parameters: [{ name: "temperature", type: "number", minimum: minTemp, maximum: maxTemp, required: true }],
      description: "设置目标温度"
    });
    if (Array.isArray(attrs?.hvac_modes) && attrs.hvac_modes.length) {
      caps.push({
        action: "set_hvac_mode",
        parameters: [{ name: "mode", type: "enum", enum: attrs.hvac_modes, required: true }],
        description: "切换空调模式"
      });
    }
    if (Array.isArray(attrs?.fan_modes) && attrs.fan_modes.length) {
      caps.push({
        action: "set_fan_mode",
        parameters: [{ name: "mode", type: "enum", enum: attrs.fan_modes, required: true }],
        description: "切换风速/送风模式"
      });
    }
    return caps;
  }

  return [];
}

function buildHaTraits(domain, state) {
  const attrs = state?.attributes || {};
  if (domain === "switch") {
    return { switch: { state: toSwitchState(state?.state) } };
  }
  if (domain === "light") {
    const brightness255 = typeof attrs?.brightness === "number" ? attrs.brightness : undefined;
    const brightness = typeof brightness255 === "number" ? Math.round((brightness255 / 255) * 100) : undefined;
    const out = { switch: { state: toSwitchState(state?.state) } };
    if (typeof brightness === "number") out.dimmer = { brightness };
    const kelvin = typeof attrs?.color_temp_kelvin === "number" ? attrs.color_temp_kelvin : miredToKelvin(attrs?.color_temp);
    if (typeof kelvin === "number") out.color_temp = { kelvin };
    return out;
  }
  if (domain === "cover") {
    const position = asNumber(attrs?.current_position ?? attrs?.position);
    const tilt = asNumber(attrs?.current_tilt_position ?? attrs?.tilt_position ?? attrs?.tilt);
    const cover = {};
    if (position !== undefined) cover.position = position;
    if (tilt !== undefined) cover.tilt = tilt;
    cover.state = state?.state;
    return { cover };
  }
  if (domain === "climate") {
    return {
      climate: {
        hvac_mode: attrs?.hvac_mode ?? state?.state,
        temperature: attrs?.temperature,
        current_temperature: attrs?.current_temperature,
        fan_mode: attrs?.fan_mode
      }
    };
  }
  return { raw: { state: state?.state, attributes: attrs } };
}

function deriveKelvinRange(attrs) {
  const minMireds = typeof attrs?.min_mireds === "number" ? attrs.min_mireds : undefined;
  const maxMireds = typeof attrs?.max_mireds === "number" ? attrs.max_mireds : undefined;
  // HA mireds: smaller mired => higher kelvin. Convert best-effort.
  const maxKelvin = minMireds ? Math.round(1_000_000 / minMireds) : 6500;
  const minKelvin = maxMireds ? Math.round(1_000_000 / maxMireds) : 1500;
  return {
    minKelvin: clampNumber(minKelvin, 1000, 20_000),
    maxKelvin: clampNumber(maxKelvin, 1000, 20_000)
  };
}

function buildHaWsUrl(baseUrl) {
  const u = new URL(stripTrailingSlash(baseUrl));
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/api/websocket`;
}

function toSwitchState(state) {
  if (!state) return "off";
  const lower = String(state).toLowerCase();
  return lower === "on" ? "on" : "off";
}

function asNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function miredToKelvin(mired) {
  const n = asNumber(mired);
  if (typeof n !== "number" || n <= 0) return undefined;
  return Math.round(1_000_000 / n);
}

function clampNumber(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function uniqStrings(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const s = String(item || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function safeParseJson(data) {
  try {
    const str = typeof data === "string" ? data : data?.toString?.("utf8") ?? String(data);
    return JSON.parse(str);
  } catch (_e) {
    return undefined;
  }
}

function stripTrailingSlash(s) {
  return String(s || "").replace(/\/$/, "");
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch (_e) {
    return "";
  }
}
