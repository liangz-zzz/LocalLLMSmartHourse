import Fastify from "fastify";

export function buildApp(options = {}) {
  const forwardBase = options.forwardBase || process.env.UPSTREAM_API_BASE || "";
  const forwardApiKey = options.forwardApiKey || process.env.UPSTREAM_API_KEY || process.env.LLM_API_KEY || "";
  const forwardEnabled = Boolean(forwardBase);
  const rateLimitPerMin = Number(process.env.RATE_LIMIT_PER_MIN || 60);
  const limiter = buildLimiter(rateLimitPerMin);
  const metrics = buildMetrics();

  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/v1/chat/completions", async (req, reply) => {
    if (!limiter.ok(req)) return reply.code(429).send({ error: "rate_limited" });
    const { messages = [], model = "local-echo" } = req.body || {};
    metrics.count("chat_requests");

    if (forwardEnabled) {
      try {
        const target = `${forwardBase.replace(/\/$/, "")}/v1/chat/completions`;
        const upstream = await fetch(target, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(forwardApiKey ? { Authorization: `Bearer ${forwardApiKey}` } : {})
          },
          body: JSON.stringify({ ...req.body, model })
        });
        if (!upstream.ok) {
          const text = await upstream.text();
          app.log?.warn?.("Upstream LLM error", upstream.status, text);
          metrics.count("chat_upstream_error");
        } else {
          const data = await upstream.json();
          metrics.count("chat_upstream_ok");
          return reply.send(data);
        }
      } catch (err) {
        app.log?.warn?.("Upstream LLM call failed, falling back to echo", err);
        metrics.count("chat_upstream_fail");
      }
    }

    const content = buildEcho(messages);
    const resp = {
      id: `chatcmpl_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: content.length,
        total_tokens: content.length
      }
    };
    return reply.send(resp);
  });

  app.post("/v1/intent", async (req, reply) => {
    if (!limiter.ok(req)) return reply.code(429).send({ error: "rate_limited" });
    const { input, messages = [], devices = [], model, strategy } = req.body || {};
    metrics.count("intent_requests");
    const text = input || extractLastUser(messages);
    if (!text) {
      return reply.code(400).send({ error: "input_required" });
    }
    const result = await resolveIntent({
      input: text,
      messages,
      devices,
      model,
      strategy,
      forwardEnabled,
      forwardBase,
      forwardApiKey,
      metrics,
      logger: app.log
    });
    return reply.send(result);
  });

  app.get("/metrics", async (req, reply) => {
    const format = req.query?.format;
    if (format === "prom") {
      reply.header("Content-Type", "text/plain");
      return reply.send(metrics.asPrometheus("llm_bridge"));
    }
    reply.send(metrics.snapshot());
  });

  app.setErrorHandler((err, _req, reply) => {
    reply.code(500).send({ error: "internal_error", message: err.message });
  });

  return app;
}

function buildEcho(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return lastUser?.content ? `Echo: ${lastUser.content}` : "Hello from llm-bridge stub.";
}

export function parseIntent({ input, messages = [], devices = [] }) {
  const text = normalizeText(input || extractLastUser(messages) || "");
  const action = detectAction(text);
  const params = detectParams(text);
  const room = detectRoom(text);
  const scored = scoreDevices({ text, devices, room, action });

  const candidates = (scored.length ? scored : [{ device: null, score: 0.2, reason: "no_device_match" }]).map((item) => {
    const confidence = clamp(item.score, 0, 1);
    const summary = buildSummary({ action, device: item.device, params, room, reason: item.reason });
    return {
      action: action || "unknown",
      deviceId: item.device?.id,
      params,
      confidence,
      room,
      summary
    };
  });

  const intent = { ...candidates[0] };
  return { intent, candidates };
}

function detectAction(text) {
  if (/调.*亮度|brightness|%/.test(text)) return "set_brightness";
  if (/温度|temperature|摄氏|(?<!亮)度/.test(text)) return "set_temperature";
  if (/停止烧水|别烧水|不要烧水|停(止)?烧水|停止加热/.test(text)) return "turn_off";
  if (/烧水|煮水|开水|热水|加热水壶/.test(text)) return "turn_on";
  if (/turn\s*on|打开|开(灯|关|一下)?/.test(text)) return "turn_on";
  if (/turn\s*off|关(灯|掉|一下)?/.test(text)) return "turn_off";
  if (/暖气|加热|heat/.test(text)) return "set_hvac_mode";
  if (/制冷|cool/.test(text)) return "set_hvac_mode";
  return null;
}

function detectParams(text) {
  const params = {};
  const brightnessMatch = text.match(/(\d{1,3})\s*%/);
  if (brightnessMatch) {
    params.brightness = clamp(Number(brightnessMatch[1]), 0, 100);
  }
  const tempMatch = text.match(/(\d{2})(?:\s*度|c|celsius)/);
  if (tempMatch) {
    params.temperature = Number(tempMatch[1]);
  }
  if (/heat|制热|加热/.test(text)) params.mode = "heat";
  if (/cool|制冷/.test(text)) params.mode = "cool";
  return params;
}

function detectRoom(text) {
  if (/客厅|living/.test(text)) return "living_room";
  if (/卧室|bedroom/.test(text)) return "bedroom";
  if (/书房|study/.test(text)) return "study";
  if (/厨房|kitchen/.test(text)) return "kitchen";
  return null;
}

function scoreDevices({ text, devices, room, action }) {
  const scores = [];
  for (const d of devices || []) {
    let score = 0.2;
    const reason = [];
    const id = normalizeText(d.id);
    const name = normalizeText(d.name);
    const aliases = Array.isArray(d.semantics?.aliases) ? d.semantics.aliases.map(normalizeText).filter(Boolean) : [];
    const tags = Array.isArray(d.semantics?.tags) ? d.semantics.tags.map(normalizeText).filter(Boolean) : [];

    if (id && text.includes(id)) {
      score += 0.6;
      reason.push("id");
    }
    if (name && text.includes(name)) {
      score += 0.6;
      reason.push("name");
    }
    if (aliases.some((a) => a && text.includes(a))) {
      score += 0.7;
      reason.push("alias");
    }
    if (tags.some((t) => t && text.includes(t))) {
      score += 0.25;
      reason.push("tag");
    }

    const placementRoomKey = normalizeRoom(d.placement?.room);
    const roomKey = normalizeRoom(room);
    if (roomKey && placementRoomKey && placementRoomKey.includes(roomKey)) {
      score += 0.3;
      reason.push("room");
    }

    if (action && d.capabilities?.some((c) => c.action === action)) {
      score += 0.25;
      reason.push("capability");
    }
    scores.push({ device: d, score, reason: reason.join(",") });
  }
  return scores.sort((a, b) => b.score - a.score);
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return n;
  return Math.max(min, Math.min(max, n));
}

function buildSummary({ action, device, params, room, reason }) {
  const parts = [];
  if (action) parts.push(`action=${action}`);
  if (device) parts.push(`device=${device.id}`);
  if (room) parts.push(`room=${room}`);
  const paramStr = Object.entries(params || {})
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
  if (paramStr) parts.push(`params=${paramStr}`);
  if (reason) parts.push(`reason=${reason}`);
  return parts.join(" | ") || "no_intent";
}

function extractLastUser(messages) {
  if (!Array.isArray(messages)) return null;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return lastUser?.content || null;
}

async function resolveIntent({
  input,
  messages,
  devices,
  model,
  strategy,
  forwardEnabled,
  forwardBase,
  forwardApiKey,
  metrics,
  logger
}) {
  const ruleResult = parseIntent({ input, messages, devices });

  const configuredStrategy = String(strategy || process.env.INTENT_STRATEGY || "").toLowerCase().trim();
  const defaultStrategy = forwardEnabled ? "hybrid" : "rules";
  const useStrategy = (configuredStrategy || defaultStrategy).replace(/_/g, "-");

  if (!forwardEnabled || useStrategy === "rules") return ruleResult;

  const threshold = clamp(Number(process.env.INTENT_RULE_CONFIDENCE_THRESHOLD || 0.85), 0, 1);
  const ruleIntent = ruleResult.intent || {};
  const ruleConf = typeof ruleIntent.confidence === "number" ? ruleIntent.confidence : 0;
  const ruleOk = Boolean(ruleIntent.deviceId) && ruleIntent.action && ruleIntent.action !== "unknown" && ruleConf >= threshold;
  if (useStrategy === "hybrid" && ruleOk) return ruleResult;

  try {
    const llmIntent = await parseIntentWithUpstream({
      input,
      devices,
      model,
      forwardBase,
      forwardApiKey
    });
    metrics?.count?.("intent_upstream_ok");
    const enriched = {
      ...llmIntent,
      summary: [llmIntent.summary, "source=llm"].filter(Boolean).join(" | ")
    };
    const candidates = [
      enriched,
      ...(Array.isArray(ruleResult.candidates) ? ruleResult.candidates.map((c) => ({ ...c, summary: [c.summary, "source=rules"].filter(Boolean).join(" | ") })) : [])
    ].slice(0, 5);
    return { intent: enriched, candidates };
  } catch (err) {
    logger?.warn?.("Intent upstream failed, falling back to rules", err?.message || String(err));
    metrics?.count?.("intent_upstream_fail");
    return ruleResult;
  }
}

async function parseIntentWithUpstream({ input, devices, model, forwardBase, forwardApiKey }) {
  const intentModel = model || process.env.INTENT_MODEL || "deepseek-chat";
  const promptDevices = compactDevicesForPrompt(devices);

  const system = [
    "You are a smart home intent parser.",
    "Return ONLY valid JSON (no markdown, no code fences).",
    "Pick ONE best matching device and ONE action from that device's capabilities.",
    "Use action names exactly as listed in capabilities (e.g. turn_on, turn_off, set_brightness).",
    "If you cannot decide, use {\"action\":\"unknown\",\"deviceId\":null,\"params\":{},\"confidence\":0.2}.",
    "confidence must be a number 0..1."
  ].join("\n");

  const user = JSON.stringify(
    {
      input,
      devices: promptDevices,
      output_schema: {
        action: "string",
        deviceId: "string|null",
        params: "object",
        confidence: "number 0..1",
        room: "string|null (optional)",
        summary: "string (optional)"
      }
    },
    null,
    2
  );

  const data = await callUpstreamChatCompletions({
    forwardBase,
    forwardApiKey,
    body: {
      model: intentModel,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    }
  });

  const content = data?.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(extractJson(content));
  const intent = normalizeIntentOutput(parsed);

  // Validate against provided devices/capabilities to avoid unsafe hallucinations
  const device = (devices || []).find((d) => d?.id === intent.deviceId);
  if (intent.action !== "unknown") {
    if (!device || !Array.isArray(device.capabilities) || !device.capabilities.some((c) => c.action === intent.action)) {
      return {
        action: "unknown",
        deviceId: null,
        params: {},
        confidence: 0.2,
        room: null,
        summary: "upstream_invalid_device_or_action"
      };
    }
  }

  return {
    action: intent.action,
    deviceId: intent.deviceId,
    params: intent.params || {},
    confidence: clamp(intent.confidence, 0, 1),
    room: intent.room || null,
    summary: intent.summary || "upstream_intent"
  };
}

async function callUpstreamChatCompletions({ forwardBase, forwardApiKey, body }) {
  const target = `${String(forwardBase).replace(/\/$/, "")}/v1/chat/completions`;
  const res = await fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(forwardApiKey ? { Authorization: `Bearer ${forwardApiKey}` } : {})
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upstream ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function compactDevicesForPrompt(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const max = Number(process.env.INTENT_MAX_DEVICES || 50);
  return list.slice(0, Math.max(1, max)).map((d) => ({
    id: d.id,
    name: d.name,
    placement: d.placement,
    semantics: d.semantics,
    capabilities: Array.isArray(d.capabilities)
      ? d.capabilities.map((c) => ({ action: c.action, parameters: c.parameters || [] }))
      : []
  }));
}

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return raw;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();
  const firstObj = raw.indexOf("{");
  const lastObj = raw.lastIndexOf("}");
  if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) return raw.slice(firstObj, lastObj + 1).trim();
  const firstArr = raw.indexOf("[");
  const lastArr = raw.lastIndexOf("]");
  if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) return raw.slice(firstArr, lastArr + 1).trim();
  return raw;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

function normalizeIntentOutput(obj) {
  const o = obj && typeof obj === "object" ? obj : {};
  const action = typeof o.action === "string" ? o.action : "unknown";
  const deviceId = typeof o.deviceId === "string" && o.deviceId.trim() ? o.deviceId : null;
  const params = o.params && typeof o.params === "object" && !Array.isArray(o.params) ? o.params : {};
  const confidence = typeof o.confidence === "number" ? o.confidence : 0.2;
  const room = typeof o.room === "string" ? o.room : null;
  const summary = typeof o.summary === "string" ? o.summary : "";
  return { action, deviceId, params, confidence, room, summary };
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeRoom(value) {
  if (!value) return "";
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "");
}

function buildLimiter(limitPerMin) {
  const windowMs = 60_000;
  let bucket = {};
  let windowStart = Date.now();
  const ok = (req) => {
    if (!limitPerMin || limitPerMin <= 0) return true;
    const now = Date.now();
    if (now - windowStart > windowMs) {
      bucket = {};
      windowStart = now;
    }
    const key = req.ip || req.headers["x-forwarded-for"] || "unknown";
    bucket[key] = (bucket[key] || 0) + 1;
    return bucket[key] <= limitPerMin;
  };
  return { ok };
}

function buildMetrics() {
  const counters = {};
  return {
    count: (name) => {
      counters[name] = (counters[name] || 0) + 1;
    },
    snapshot: () => ({ counters: { ...counters } }),
    asPrometheus: (ns) => {
      return Object.entries(counters)
        .map(([k, v]) => `${ns}_${k} ${v}`)
        .join("\n");
    }
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT || 5000);
  const app = buildApp();
  app.listen({ port, host: "0.0.0.0" }).then(() => {
    console.log(`llm-bridge listening on :${port}`);
  });
}
