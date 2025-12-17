const TOOLS = [
  {
    name: "system.health",
    description: "Return MCP server health and upstream connectivity hints.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "devices.list",
    description: "List devices (optionally filter by ids/room/tag/query).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ids: { type: "array", items: { type: "string" } },
        room: { type: "string" },
        tag: { type: "string" },
        query: { type: "string" }
      }
    }
  },
  {
    name: "devices.get",
    description: "Get a device by id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } }
    }
  },
  {
    name: "devices.state",
    description: "Get current traits/state for one device.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } }
    }
  },
  {
    name: "devices.invoke",
    description: "Invoke a supported action on a device (capabilities-validated).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["deviceId", "action"],
      properties: {
        deviceId: { type: "string" },
        action: { type: "string" },
        params: { type: "object" },
        dryRun: { type: "boolean" },
        confirm: { type: "boolean" },
        requestId: { type: "string" }
      }
    }
  },
  {
    name: "actions.batch_invoke",
    description: "Invoke multiple actions (each capability-validated).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["actions"],
      properties: {
        dryRun: { type: "boolean" },
        confirm: { type: "boolean" },
        requestId: { type: "string" },
        actions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["deviceId", "action"],
            properties: {
              deviceId: { type: "string" },
              action: { type: "string" },
              params: { type: "object" }
            }
          }
        }
      }
    }
  },
  {
    name: "actions.list",
    description: "List recent action results for a device (requires action store enabled in api-gateway).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["deviceId"],
      properties: {
        deviceId: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" }
      }
    }
  }
];

export function buildTools() {
  return TOOLS;
}

export async function callTool({ name, args, config }) {
  try {
    if (name === "system.health") return await systemHealth({ config });
    if (name === "devices.list") return await devicesList({ args, config });
    if (name === "devices.get") return await devicesGet({ args, config });
    if (name === "devices.state") return await devicesState({ args, config });
    if (name === "devices.invoke") return await devicesInvoke({ args, config });
    if (name === "actions.batch_invoke") return await actionsBatchInvoke({ args, config });
    if (name === "actions.list") return await actionsList({ args, config });
  } catch (err) {
    return asError("tool_execution_failed", err?.message || String(err));
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "unknown_tool", name }, null, 2)
      }
    ],
    isError: true
  };
}

async function devicesList({ args, config }) {
  const res = await fetchJson(`${config.apiGatewayBase}/devices`, {
    headers: authHeaders(config)
  });

  let items = res.items || [];
  const ids = Array.isArray(args?.ids) ? args.ids : null;
  const room = typeof args?.room === "string" ? args.room.trim() : "";
  const tag = typeof args?.tag === "string" ? args.tag.trim() : "";
  const query = typeof args?.query === "string" ? args.query.trim() : "";

  if (ids?.length) {
    const set = new Set(ids);
    items = items.filter((d) => set.has(d.id));
  }
  if (room) {
    const key = normalize(room);
    items = items.filter((d) => normalize(d?.placement?.room).includes(key));
  }
  if (tag) {
    const key = normalize(tag);
    items = items.filter((d) => Array.isArray(d?.semantics?.tags) && d.semantics.tags.map(normalize).includes(key));
  }
  if (query) {
    const q = normalize(query);
    items = items.filter((d) => {
      const hay = [d.id, d.name, d?.semantics?.description, ...(d?.semantics?.aliases || [])].map(normalize).join(" ");
      return hay.includes(q);
    });
  }

  return asJsonResult({ items, count: items.length });
}

async function devicesGet({ args, config }) {
  const id = String(args?.id || "").trim();
  if (!id) return asError("invalid_args", "id is required");
  const device = await fetchJson(`${config.apiGatewayBase}/devices/${encodeURIComponent(id)}`, {
    headers: authHeaders(config)
  });
  return asJsonResult(device);
}

async function devicesState({ args, config }) {
  const id = String(args?.id || "").trim();
  if (!id) return asError("invalid_args", "id is required");
  const device = await fetchJson(`${config.apiGatewayBase}/devices/${encodeURIComponent(id)}`, {
    headers: authHeaders(config)
  });
  return asJsonResult({ id: device.id, traits: device.traits || {}, updatedAt: Date.now() });
}

async function devicesInvoke({ args, config }) {
  const deviceId = String(args?.deviceId || "").trim();
  const action = String(args?.action || "").trim();
  const params = isPlainObject(args?.params) ? args.params : {};
  const dryRun = typeof args?.dryRun === "boolean" ? args.dryRun : config.defaultDryRun;
  const confirm = typeof args?.confirm === "boolean" ? args.confirm : false;
  const requestId = typeof args?.requestId === "string" ? args.requestId.trim() : "";

  if (!deviceId || !action) return asError("invalid_args", "deviceId/action are required");

  return withIdempotency(requestId, async () => {
    const device = await fetchJson(`${config.apiGatewayBase}/devices/${encodeURIComponent(deviceId)}`, {
      headers: authHeaders(config)
    });
    const supported = Array.isArray(device?.capabilities) && device.capabilities.some((c) => c.action === action);
    if (!supported) return asError("action_not_supported", `device ${deviceId} does not support ${action}`);

    if (dryRun) {
      return asJsonResult({
        requestId: requestId || undefined,
        status: "dry_run_ok",
        deviceId,
        action,
        params,
        next: { tool: "devices.invoke", args: { deviceId, action, params, dryRun: false, confirm: true } }
      });
    }

    if (!confirm) {
      return asError("confirmation_required", "write action requires confirm=true");
    }

    const resp = await fetchJson(`${config.apiGatewayBase}/devices/${encodeURIComponent(deviceId)}/actions`, {
      method: "POST",
      headers: { ...authHeaders(config), "Content-Type": "application/json" },
      body: JSON.stringify({ action, params })
    });
    return asJsonResult({ requestId: requestId || undefined, status: "queued", response: resp });
  });
}

async function actionsBatchInvoke({ args, config }) {
  const dryRun = typeof args?.dryRun === "boolean" ? args.dryRun : config.defaultDryRun;
  const confirm = typeof args?.confirm === "boolean" ? args.confirm : false;
  const requestId = typeof args?.requestId === "string" ? args.requestId.trim() : "";
  const list = Array.isArray(args?.actions) ? args.actions : [];
  if (!list.length) return asError("invalid_args", "actions[] is required");

  if (!dryRun && !confirm) {
    return asError("confirmation_required", "batch write requires confirm=true");
  }

  return withIdempotency(requestId, async () => {
    const results = [];
    for (const item of list) {
      const deviceId = String(item?.deviceId || "").trim();
      const action = String(item?.action || "").trim();
      const params = isPlainObject(item?.params) ? item.params : {};
      if (!deviceId || !action) {
        results.push({ deviceId, action, ok: false, error: "invalid_action_item" });
        continue;
      }
      const r = await devicesInvoke({ args: { deviceId, action, params, dryRun, confirm, requestId: requestId ? `${requestId}:${deviceId}:${action}` : "" }, config });
      results.push({ deviceId, action, ok: !r.isError, result: extractJsonFromResult(r) });
    }
    return asJsonResult({ requestId: requestId || undefined, dryRun, results });
  });
}

async function actionsList({ args, config }) {
  const deviceId = String(args?.deviceId || "").trim();
  if (!deviceId) return asError("invalid_args", "deviceId is required");
  const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(Number(args.limit), 100)) : 20;
  const offset = Number.isFinite(args?.offset) ? Math.max(0, Number(args.offset)) : 0;

  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const url = `${config.apiGatewayBase}/devices/${encodeURIComponent(deviceId)}/actions?${qs.toString()}`;
  try {
    const res = await fetchJson(url, { headers: authHeaders(config) });
    return asJsonResult(res);
  } catch (err) {
    return asError("upstream_error", err?.message || String(err));
  }
}

async function systemHealth({ config }) {
  let gateway = { ok: false };
  try {
    const res = await fetchJson(`${config.apiGatewayBase}/health`, { headers: authHeaders(config) });
    gateway = { ok: true, status: res.status || "ok" };
  } catch (err) {
    gateway = { ok: false, error: err?.message || String(err) };
  }
  return asJsonResult({
    status: "ok",
    apiGatewayBase: config.apiGatewayBase,
    gateway
  });
}

function authHeaders(config) {
  return config.apiGatewayApiKey ? { "X-API-Key": config.apiGatewayApiKey } : {};
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upstream ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function asJsonResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }]
  };
}

function asError(code, message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, message }, null, 2) }],
    isError: true
  };
}

function extractJsonFromResult(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function normalize(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const idempotencyCache = new Map();

async function withIdempotency(requestId, fn) {
  const key = String(requestId || "").trim();
  if (!key) return fn();

  const now = Date.now();
  const existing = idempotencyCache.get(key);
  if (existing && now - existing.ts < IDEMPOTENCY_TTL_MS) return existing.value;

  const value = await fn();
  idempotencyCache.set(key, { ts: now, value });
  return value;
}
