import { spawn } from "node:child_process";

const DEFAULT_ACK_KEYWORDS = ["我在", "请说", "请讲"];
const DEFAULT_ACK_TIMEOUT_MS = 4000;
const DEFAULT_LISTEN_WINDOW_MS = 4000;
const DEFAULT_WAKE_RETRIES = 1;
const DEFAULT_WAKE_GAP_MS = 600;
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;

export function createCommandVoiceRuntime({ ttsCommand, sttCommand, commandTimeoutMs, logger }) {
  const safeTimeoutMs = asPositiveInt(commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
  return {
    async speak({ text, output, micId, deviceId, action, phase }) {
      if (!ttsCommand) {
        throw buildRuntimeError("voice_tts_command_not_configured", "VOICE_TTS_COMMAND is not configured");
      }
      await runShellCommand({
        command: ttsCommand,
        timeoutMs: safeTimeoutMs,
        env: {
          VOICE_TEXT: String(text || ""),
          VOICE_OUTPUT: output ? String(output) : "",
          VOICE_MIC_ID: micId ? String(micId) : "",
          VOICE_DEVICE_ID: deviceId ? String(deviceId) : "",
          VOICE_ACTION: action ? String(action) : "",
          VOICE_PHASE: phase ? String(phase) : ""
        },
        logger
      });
    },

    async listen({ mic, timeoutMs, listenWindowMs, deviceId, action }) {
      if (!sttCommand) {
        throw buildRuntimeError("voice_stt_command_not_configured", "VOICE_STT_COMMAND is not configured");
      }
      const limit = Math.max(asPositiveInt(timeoutMs, DEFAULT_ACK_TIMEOUT_MS), asPositiveInt(listenWindowMs, DEFAULT_LISTEN_WINDOW_MS));
      const out = await runShellCommand({
        command: sttCommand,
        timeoutMs: limit + 2000,
        env: {
          VOICE_MIC_ID: String(mic?.id || ""),
          VOICE_MIC_INPUT_DEVICE: mic?.input_device == null ? "" : String(mic.input_device),
          VOICE_TIMEOUT_MS: String(asPositiveInt(timeoutMs, DEFAULT_ACK_TIMEOUT_MS)),
          VOICE_LISTEN_WINDOW_MS: String(asPositiveInt(listenWindowMs, DEFAULT_LISTEN_WINDOW_MS)),
          VOICE_DEVICE_ID: deviceId ? String(deviceId) : "",
          VOICE_ACTION: action ? String(action) : ""
        },
        logger
      });
      return parseListenOutput(out.stdout);
    }
  };
}

export async function executeVoiceControlAction({ device, actionName, params, voiceBinding, voiceConfig, runtime, logger }) {
  if (!voiceBinding || typeof voiceBinding !== "object") {
    return fail("voice_binding_missing", "设备未配置 voice_control，无法执行语音控制。");
  }
  if (!runtime || typeof runtime.speak !== "function" || typeof runtime.listen !== "function") {
    return fail("voice_runtime_unavailable", "语音运行时未配置，无法执行语音控制。");
  }

  const actionSpec = voiceBinding?.actions?.[actionName];
  if (!actionSpec || !Array.isArray(actionSpec.utterances) || actionSpec.utterances.length === 0) {
    return fail("voice_action_not_configured", `动作 ${actionName} 未配置语音命令模板。`);
  }

  const wakeUtterances = asStringList(voiceBinding?.wake?.utterances);
  if (!wakeUtterances.length) {
    return fail("voice_wake_not_configured", "设备未配置唤醒词，无法发起语音会话。");
  }

  const selection = selectNearestMic({
    mics: voiceConfig?.mics || [],
    devicePlacement: device?.placement || {},
    preferredMicIds: asStringList(voiceBinding?.preferred_mics),
    maxDistance: voiceConfig?.mic_selection?.max_distance
  });

  if (!selection.ok) {
    return fail(selection.errorCode, selection.reason, selection.details);
  }

  const ackKeywords = resolveAckKeywords({ voiceBinding, voiceConfig });
  const ackTimeoutMs = asPositiveInt(voiceBinding?.ack?.timeout_ms, DEFAULT_ACK_TIMEOUT_MS);
  const listenWindowMs = asPositiveInt(voiceBinding?.ack?.listen_window_ms, DEFAULT_LISTEN_WINDOW_MS);
  const wakeRetries = asNonNegativeInt(voiceBinding?.wake?.retries, DEFAULT_WAKE_RETRIES);
  const wakeGapMs = asNonNegativeInt(voiceBinding?.wake?.gap_ms, DEFAULT_WAKE_GAP_MS);
  const attempts = Math.max(1, wakeRetries + 1);

  let detectedResponse = "";
  let matched = false;
  let finalReasonCode = "ack_timeout";

  for (let i = 0; i < attempts; i++) {
    const wakeText = pickUtterance(wakeUtterances, i, actionSpec?.deterministic);
    try {
      await runtime.speak({
        text: wakeText,
        output: voiceBinding?.audio_output,
        micId: selection.mic.id,
        deviceId: device?.id,
        action: actionName,
        phase: "wake"
      });
    } catch (err) {
      return fail("voice_wake_failed", runtimeErrorText(err), {
        selected_mic_id: selection.mic.id,
        wake_attempt: i + 1
      });
    }

    if (wakeGapMs > 0) await sleep(wakeGapMs);

    let listenResult;
    try {
      listenResult = await runtime.listen({
        mic: selection.mic,
        timeoutMs: ackTimeoutMs,
        listenWindowMs,
        deviceId: device?.id,
        action: actionName
      });
    } catch (err) {
      return fail("voice_listen_failed", runtimeErrorText(err), {
        selected_mic_id: selection.mic.id,
        wake_attempt: i + 1
      });
    }

    const text = normalizeText(String(listenResult?.text || ""));
    if (!text) {
      finalReasonCode = "ack_timeout";
      continue;
    }
    detectedResponse = text;
    if (matchesKeyword(text, ackKeywords)) {
      matched = true;
      break;
    }
    finalReasonCode = "ack_keyword_not_matched";
  }

  if (!matched) {
    if (detectedResponse || finalReasonCode === "ack_keyword_not_matched") {
      return fail(
        "ack_keyword_not_matched",
        buildAckMismatchReason({ detectedResponse, ackKeywords }),
        {
          selected_mic_id: selection.mic.id,
          detected_response: detectedResponse,
          expected_keywords: ackKeywords,
          wake_attempts: attempts
        }
      );
    }
    return fail(
      "ack_timeout",
      `等待设备响应超时（${ackTimeoutMs}ms），期望关键词为“${ackKeywords.join("、")}”，未执行控制。`,
      {
        selected_mic_id: selection.mic.id,
        detected_response: detectedResponse,
        expected_keywords: ackKeywords,
        wake_attempts: attempts
      }
    );
  }

  const template = pickUtterance(asStringList(actionSpec.utterances), 0, actionSpec?.deterministic);
  const rendered = renderTemplate(template, buildTemplateContext({ device, actionName, params }));
  if (!rendered.ok) {
    return fail(
      "voice_template_param_missing",
      `语音命令模板缺少参数：${rendered.missing.join("、")}，已阻止执行。`,
      {
        selected_mic_id: selection.mic.id,
        detected_response: detectedResponse,
        expected_keywords: ackKeywords
      }
    );
  }

  const preDelayMs = asNonNegativeInt(actionSpec.pre_delay_ms, 0);
  if (preDelayMs > 0) await sleep(preDelayMs);

  try {
    await runtime.speak({
      text: rendered.text,
      output: voiceBinding?.audio_output,
      micId: selection.mic.id,
      deviceId: device?.id,
      action: actionName,
      phase: "command"
    });
  } catch (err) {
    return fail("voice_command_failed", runtimeErrorText(err), {
      selected_mic_id: selection.mic.id,
      detected_response: detectedResponse,
      expected_keywords: ackKeywords,
      command_text: rendered.text
    });
  }

  const postDelayMs = asNonNegativeInt(actionSpec.post_delay_ms, 0);
  if (postDelayMs > 0) await sleep(postDelayMs);

  logger?.info?.({
    msg: "voice.control.executed",
    deviceId: device?.id,
    action: actionName,
    selectedMicId: selection.mic.id
  });

  return {
    ok: true,
    selectedMicId: selection.mic.id,
    details: {
      selected_mic_id: selection.mic.id,
      detected_response: detectedResponse,
      expected_keywords: ackKeywords,
      command_text: rendered.text,
      wake_attempts: attempts
    }
  };
}

export function selectNearestMic({ mics, devicePlacement, preferredMicIds, maxDistance }) {
  const enabled = (Array.isArray(mics) ? mics : []).filter((m) => m && m.enabled !== false && String(m.id || "").trim());
  if (!enabled.length) {
    return {
      ok: false,
      errorCode: "no_suitable_mic",
      reason: "没有可用麦克风，无法监听设备应答。",
      details: { candidate_mics: [] }
    };
  }

  const preferred = new Set(asStringList(preferredMicIds));
  const scoped = preferred.size > 0 ? enabled.filter((m) => preferred.has(String(m.id))) : enabled;
  const candidates = scoped.length ? scoped : enabled;
  const roomKey = normalizeKey(devicePlacement?.room);

  const ranked = candidates
    .map((mic, index) => {
      const micRoom = normalizeKey(mic?.placement?.room);
      const sameRoom = Boolean(roomKey) && roomKey === micRoom;
      const distance = computeDistance(devicePlacement?.coordinates, mic?.placement?.coordinates);
      const hasDistance = Number.isFinite(distance);
      return { mic, index, sameRoom, distance, hasDistance };
    })
    .sort((a, b) => {
      if (a.sameRoom !== b.sameRoom) return a.sameRoom ? -1 : 1;
      if (a.hasDistance !== b.hasDistance) return a.hasDistance ? -1 : 1;
      if (a.hasDistance && b.hasDistance && a.distance !== b.distance) return a.distance - b.distance;
      return a.index - b.index;
    });

  const selected = ranked[0];
  if (!selected) {
    return {
      ok: false,
      errorCode: "no_suitable_mic",
      reason: "没有可用麦克风，无法监听设备应答。",
      details: { candidate_mics: candidates.map((m) => m.id) }
    };
  }

  const limit = Number(maxDistance);
  if (Number.isFinite(limit)) {
    const tooFar = selected.hasDistance && selected.distance > limit;
    const unknownDistance = !selected.sameRoom && !selected.hasDistance;
    if (tooFar || unknownDistance) {
      return {
        ok: false,
        errorCode: "max_distance_exceeded",
        reason: `最近麦克风超过最大距离限制（max_distance=${limit}），已阻止执行。`,
        details: {
          selected_mic_id: selected.mic.id,
          selected_distance: selected.hasDistance ? selected.distance : null,
          max_distance: limit
        }
      };
    }
  }

  return { ok: true, mic: selected.mic, distance: selected.hasDistance ? selected.distance : null, sameRoom: selected.sameRoom };
}

export function renderTemplate(template, context) {
  const text = String(template || "");
  const missing = [];
  const rendered = text.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, key) => {
    if (!Object.prototype.hasOwnProperty.call(context, key) || context[key] === undefined || context[key] === null) {
      missing.push(key);
      return "";
    }
    return String(context[key]);
  });
  if (missing.length) return { ok: false, text: rendered, missing: uniqStrings(missing) };
  return { ok: true, text: rendered.trim(), missing: [] };
}

function resolveAckKeywords({ voiceBinding, voiceConfig }) {
  const fromDevice = asStringList(voiceBinding?.ack?.keywords);
  if (fromDevice.length) return fromDevice;
  const fromGlobal = asStringList(voiceConfig?.defaults?.ack_keywords);
  if (fromGlobal.length) return fromGlobal;
  return DEFAULT_ACK_KEYWORDS;
}

function buildTemplateContext({ device, actionName, params }) {
  const out = {
    device_id: String(device?.id || ""),
    device_name: String(device?.name || ""),
    room: String(device?.placement?.room || ""),
    action: String(actionName || "")
  };
  const alias = Array.isArray(device?.semantics?.aliases) ? device.semantics.aliases[0] : undefined;
  if (alias) out.device_alias = String(alias);

  const plainParams = params && typeof params === "object" ? params : {};
  for (const [k, v] of Object.entries(plainParams)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }

  if (out.value === undefined) {
    const keys = Object.keys(plainParams);
    if (keys.length === 1) out.value = plainParams[keys[0]];
  }
  return out;
}

function parseListenOutput(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) return { text: "", timedOut: true };
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          text: String(parsed.text || "").trim(),
          timedOut: Boolean(parsed.timedOut)
        };
      }
    } catch (_err) {
      // fallback to plain text
    }
  }
  return { text: raw, timedOut: false };
}

function runtimeErrorText(err) {
  if (!err) return "语音运行时失败";
  if (err?.message) return String(err.message);
  return String(err);
}

function buildAckMismatchReason({ detectedResponse, ackKeywords }) {
  return `设备响应内容“${detectedResponse}”，期望关键词为“${ackKeywords.join("、")}”，关键词未匹配，未执行控制。`;
}

function matchesKeyword(text, keywords) {
  const normalizedText = normalizeMatchText(text);
  for (const kw of keywords) {
    const candidate = normalizeMatchText(kw);
    if (!candidate) continue;
    if (normalizedText.includes(candidate)) return true;
  }
  return false;
}

function normalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？,.!?；;：:]/g, "")
    .trim();
}

function normalizeText(value) {
  return String(value || "").trim();
}

function computeDistance(a, b) {
  const c1 = a && typeof a === "object" ? a : {};
  const c2 = b && typeof b === "object" ? b : {};

  if (isFiniteNumber(c1.lat) && isFiniteNumber(c1.lon) && isFiniteNumber(c2.lat) && isFiniteNumber(c2.lon)) {
    return Math.hypot(c1.lat - c2.lat, c1.lon - c2.lon);
  }
  if (isFiniteNumber(c1.x) && isFiniteNumber(c1.y) && isFiniteNumber(c2.x) && isFiniteNumber(c2.y)) {
    const z1 = isFiniteNumber(c1.z) ? c1.z : 0;
    const z2 = isFiniteNumber(c2.z) ? c2.z : 0;
    return Math.hypot(c1.x - c2.x, c1.y - c2.y, z1 - z2);
  }
  return Number.POSITIVE_INFINITY;
}

function pickUtterance(list, index, deterministic) {
  const items = asStringList(list);
  if (!items.length) return "";
  if (deterministic) return items[0];
  const idx = Math.max(0, Number(index) || 0) % items.length;
  return items[idx];
}

function asStringList(value) {
  return uniqStrings(
    (Array.isArray(value) ? value : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  );
}

function uniqStrings(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const key = String(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function asPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Math.floor(fallback);
  return Math.floor(n);
}

function asNonNegativeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return Math.floor(fallback);
  return Math.floor(n);
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function fail(errorCode, reason, details) {
  return { ok: false, errorCode, reason, details: details || {} };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRuntimeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function runShellCommand({ command, timeoutMs, env, logger }) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", String(command)], {
      env: { ...process.env, ...(env || {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      reject(buildRuntimeError("voice_command_timeout", `voice command timeout after ${timeoutMs}ms`));
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS));

    child.stdout.on("data", (buf) => {
      stdout += String(buf || "");
    });
    child.stderr.on("data", (buf) => {
      stderr += String(buf || "");
    });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      const msg = stderr.trim() || stdout.trim() || `command failed with code ${code}`;
      logger?.warn?.({ msg: "voice.command.failed", command, code, stderr: stderr.trim() });
      reject(buildRuntimeError("voice_command_failed", msg));
    });
  });
}
