import Fastify from "fastify";

export function buildApp(options = {}) {
  const forwardBase = options.forwardBase || process.env.UPSTREAM_API_BASE || "";
  const forwardApiKey = options.forwardApiKey || process.env.UPSTREAM_API_KEY || process.env.LLM_API_KEY || "";
  const forwardEnabled = Boolean(forwardBase);

  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/v1/chat/completions", async (req, reply) => {
    const { messages = [], model = "local-echo" } = req.body || {};

    if (forwardEnabled) {
      try {
        const target = `${forwardBase.replace(/\/$/, "")}/v1/chat/completions`;
        const upstream = await fetch(target, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: forwardApiKey ? `Bearer ${forwardApiKey}` : undefined
          },
          body: JSON.stringify({ ...req.body, model })
        });
        if (!upstream.ok) {
          const text = await upstream.text();
          app.log?.warn?.("Upstream LLM error", upstream.status, text);
        } else {
          const data = await upstream.json();
          return reply.send(data);
        }
      } catch (err) {
        app.log?.warn?.("Upstream LLM call failed, falling back to echo", err);
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
    const { input, devices = [] } = req.body || {};
    if (!input || typeof input !== "string") {
      return reply.code(400).send({ error: "input_required" });
    }
    const intent = parseIntent(input, devices);
    return reply.send({ intent });
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

export function parseIntent(input, devices = []) {
  const text = input.toLowerCase();
  const action = detectAction(text);
  const params = detectParams(text);
  const device = matchDevice(text, devices);
  const confidence = action ? (device ? 0.9 : 0.6) : 0.2;
  const summary = buildSummary({ action, device, params });
  return {
    action: action || "unknown",
    deviceId: device?.id,
    params,
    confidence,
    summary
  };
}

function detectAction(text) {
  if (/温度|temperature|摄氏|度/.test(text)) return "set_temperature";
  if (/turn\s*on|打开|开(灯|关|一下)?/.test(text)) return "turn_on";
  if (/turn\s*off|关(灯|掉|一下)?/.test(text)) return "turn_off";
  if (/调.*亮度|brightness|%/.test(text)) return "set_brightness";
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

function matchDevice(text, devices) {
  const matched = devices.find((d) => {
    const name = (d.name || "").toLowerCase();
    return name && text.includes(name);
  });
  return matched || devices[0];
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return n;
  return Math.max(min, Math.min(max, n));
}

function buildSummary({ action, device, params }) {
  const parts = [];
  if (action) parts.push(`action=${action}`);
  if (device) parts.push(`device=${device.id}`);
  const paramStr = Object.entries(params || {})
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
  if (paramStr) parts.push(`params=${paramStr}`);
  return parts.join(" | ") || "no_intent";
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT || 5000);
  const app = buildApp();
  app.listen({ port, host: "0.0.0.0" }).then(() => {
    console.log(`llm-bridge listening on :${port}`);
  });
}
