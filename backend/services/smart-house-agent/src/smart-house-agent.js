import { randomUUID } from "node:crypto";

const MAX_ITERATIONS = 8;
const WRITE_TOOLS = new Set(["devices.invoke", "actions.batch_invoke"]);

export function createAgent({ config, logger, sessionStore, mcp, llm }) {
  let toolCatalogTextPromise = null;

  async function toolCatalogText() {
    if (toolCatalogTextPromise) return toolCatalogTextPromise;
    toolCatalogTextPromise = (async () => {
      const { tools } = await mcp.listTools();
      return tools
        .map((t) => `- ${t.name}: ${t.description || ""}\n  inputSchema=${JSON.stringify(t.inputSchema || {})}`)
        .join("\n");
    })();
    return toolCatalogTextPromise;
  }

  async function turn({ sessionId, input, confirm }) {
    const traceId = randomUUID();
    const session = await sessionStore.getOrCreate(sessionId);

    const trimmed = String(input || "").trim();
    const isConfirm = confirm || looksLikeConfirm(trimmed);
    const isCancel = looksLikeCancel(trimmed);

    if (session.state?.pending) {
      if (isCancel) {
        session.state.pending = null;
        await sessionStore.save(session);
        return { traceId, sessionId: session.id, type: "canceled", message: "已取消待执行计划。" };
      }
      if (isConfirm) {
        const pending = session.state.pending;
        session.state.pending = null;
        await sessionStore.save(session);

        const exec = await mcp.callTool("actions.batch_invoke", {
          dryRun: false,
          confirm: true,
          requestId: pending.planId,
          actions: pending.actions
        });

        const text = summarizeBatch(exec);
        appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
        appendMessage(session, { role: "assistant", content: text }, config.maxMessages);
        await sessionStore.save(session);

        return {
          traceId,
          sessionId: session.id,
          type: "executed",
          planId: pending.planId,
          result: exec,
          message: text
        };
      }
    }

    const toolsText = await toolCatalogText();
    const system = buildSystemPrompt({ toolsText });
    const context = buildContextPrompt({ session });

    const messages = [
      { role: "system", content: system },
      { role: "system", content: context },
      ...session.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: trimmed }
    ];

    const toolCalls = [];
    const toolCallKeys = new Set();
    const toolCache = new Map();
    const facts = {
      devicesList: null,
      deviceStates: new Map()
    };

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const completion = await llm.chat({ messages, model: config.agentModel });
      const content = completion?.choices?.[0]?.message?.content || "";
      const parsed = parseJsonObject(content);

      if (!parsed) {
        logger?.warn?.({ msg: "LLM returned non-JSON", traceId, sample: String(content).slice(0, 200) });
        const fallback = "我没有拿到可解析的结构化结果。请换一种说法，或者直接告诉我要操作哪个设备。";
        appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
        appendMessage(session, { role: "assistant", content: fallback }, config.maxMessages);
        await sessionStore.save(session);
        return { traceId, sessionId: session.id, type: "error", message: fallback };
      }

      if (parsed.type === "tool_calls" && Array.isArray(parsed.tool_calls)) {
        const calls = parsed.tool_calls.slice(0, 8);
        for (const call of calls) {
          const name = String(call?.name || "").trim();
          const args = isPlainObject(call?.arguments) ? call.arguments : {};
          if (!name) continue;

          const safeArgs = enforcePolicy({ name, args, allowWrite: false });
          const key = `${name}:${stableStringify(safeArgs)}`;

          if (!toolCallKeys.has(key)) {
            toolCallKeys.add(key);
            toolCalls.push({ name, args: safeArgs });
          }

          let result;
          if (toolCache.has(key)) {
            result = toolCache.get(key);
          } else {
            result = await mcp.callTool(name, safeArgs);
            toolCache.set(key, result);
          }

          captureFacts({ name, args: safeArgs, result, facts });
          messages.push({ role: "system", content: toolResultMessage({ name, result }) });
        }
        messages.push({
          role: "system",
          content: JSON.stringify({
            tool_round_complete: true,
            instruction: "Use the tool_result facts above. Do not repeat identical tool calls in this turn. If enough, respond with type=final."
          })
        });
        continue;
      }

      if (parsed.type === "final") {
        const assistant = String(parsed.assistant || parsed.response || "").trim();
        const plan = isPlainObject(parsed.plan) ? parsed.plan : null;
        const planType = normalizePlanType(plan?.type || parsed.planType || parsed.kind);
        const proposed = Array.isArray(plan?.actions) ? plan.actions : Array.isArray(parsed.actions) ? parsed.actions : [];
        const actions = normalizeActions(proposed);

        if (actions.length) {
          const planId = String(plan?.planId || parsed.planId || randomUUID()).trim();
          const shouldExecute = decideExecutionMode({ config, planType });

          if (!shouldExecute) {
            session.state.pending = { planId, actions, createdAt: Date.now() };
            await sessionStore.save(session);
            const base =
              assistant ||
              `我将执行 ${actions.length} 个动作。`;
            const msg = withConfirmationHint(base);
            appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
            appendMessage(session, { role: "assistant", content: msg }, config.maxMessages);
            await sessionStore.save(session);
            return { traceId, sessionId: session.id, type: "propose", planId, actions, message: msg, toolCalls };
          }

          // Preflight validation (capabilities, device existence) without triggering idempotency on real execution.
          const dryrun = await mcp.callTool("actions.batch_invoke", {
            dryRun: true,
            requestId: `${planId}:dryrun`,
            actions
          });

          const dryrunOk = Array.isArray(dryrun?.results) && dryrun.results.every((r) => r?.ok);
          if (!dryrunOk) {
            const msg =
              assistant ||
              "我无法确定要执行的动作是否都可用（设备不存在/能力不支持/参数不完整）。你能确认一下要控制的设备或动作吗？";
            appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
            appendMessage(session, { role: "assistant", content: msg }, config.maxMessages);
            await sessionStore.save(session);
            return { traceId, sessionId: session.id, type: "clarify", planId, actions, message: msg, toolCalls, dryrun };
          }

          const exec = await mcp.callTool("actions.batch_invoke", {
            dryRun: false,
            confirm: true,
            requestId: planId,
            actions
          });
          const msg = summarizeBatch(exec);
          appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
          appendMessage(session, { role: "assistant", content: msg }, config.maxMessages);
          await sessionStore.save(session);
          return { traceId, sessionId: session.id, type: "executed", planId, actions, result: exec, message: msg, toolCalls };
        }

        const msg = assistant || "好的。";
        appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
        appendMessage(session, { role: "assistant", content: msg }, config.maxMessages);
        await sessionStore.save(session);
        return { traceId, sessionId: session.id, type: parsed.kind || "answer", message: msg, toolCalls };
      }

      messages.push({
        role: "system",
        content:
          'Your output must be JSON. Respond with {"type":"tool_calls",...} or {"type":"final",...} only.'
      });
    }

    const factAnswer = buildFallbackAnswer({ input: trimmed, facts });
    if (factAnswer) {
      appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
      appendMessage(session, { role: "assistant", content: factAnswer }, config.maxMessages);
      await sessionStore.save(session);
      return { traceId, sessionId: session.id, type: "answer", message: factAnswer, toolCalls };
    }

    const fallback = "我需要更多信息才能继续。你能补充一下你希望控制的设备或房间吗？";
    appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
    appendMessage(session, { role: "assistant", content: fallback }, config.maxMessages);
    await sessionStore.save(session);
    return { traceId, sessionId: session.id, type: "error", message: fallback, toolCalls };
  }

  return { turn };
}

function buildSystemPrompt({ toolsText }) {
  return [
    "You are Smart House Agent.",
    "You MUST use tools to get facts about devices/state/capabilities. Do not assume.",
    "You MUST output ONLY valid JSON (no markdown, no extra text).",
    "Tool results arrive as system JSON messages: {\"tool_result\":{\"name\":\"...\",\"result\":{...}}}.",
    "",
    "Available MCP tools:",
    toolsText,
    "",
    "Output formats:",
    '1) Tool calls: {"type":"tool_calls","tool_calls":[{"name":"devices.list","arguments":{}}]}',
    '2) Final: {"type":"final","assistant":"...","plan":{"planId":"...","type":"query|execute|propose|clarify","actions":[{"deviceId":"...","action":"turn_on|turn_off|...","params":{}}]}}',
    "",
    "Rules:",
    "- If the user asks about current state, call devices.state/devices.get first.",
    "- For clear control commands, return plan.type=execute with plan.actions.",
    "- If you want the user to confirm first (uncertainty/high impact), return plan.type=propose with plan.actions.",
    "- If unclear, return plan.type=clarify and ask a concise clarifying question in assistant.",
    "- Do NOT call the same tool with identical arguments more than once per turn."
  ].join("\n");
}

function buildContextPrompt({ session }) {
  const pending = session.state?.pending ? { planId: session.state.pending.planId, actions: session.state.pending.actions } : null;
  const ctx = {
    sessionId: session.id,
    pending
  };
  return `CONTEXT_JSON=${JSON.stringify(ctx)}`;
}

function toolResultMessage({ name, result }) {
  return JSON.stringify({ tool_result: { name, result } });
}

function parseJsonObject(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // try to extract the first {...} block
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function appendMessage(session, msg, maxMessages) {
  if (!session.messages) session.messages = [];
  session.messages.push({ role: msg.role, content: msg.content, ts: Date.now() });
  session.messages = session.messages.slice(-(Number(maxMessages) || 30));
}

function normalizeActions(list) {
  const out = [];
  for (const a of list || []) {
    const deviceId = String(a?.deviceId || a?.id || "").trim();
    const action = String(a?.action || "").trim();
    const params = isPlainObject(a?.params) ? a.params : {};
    if (!deviceId || !action) continue;
    out.push({ deviceId, action, params });
  }
  return out;
}

function enforcePolicy({ name, args, allowWrite }) {
  const next = { ...(args || {}) };
  if (WRITE_TOOLS.has(name) && !allowWrite) {
    next.dryRun = true;
    next.confirm = false;
  }
  return next;
}

function looksLikeConfirm(text) {
  return /^(确认|执行|好的|可以|行|是|yes|y)$/i.test(String(text || "").trim());
}

function looksLikeCancel(text) {
  return /^(取消|不要|算了|停止|退出|cancel|no|n)$/i.test(String(text || "").trim());
}

function summarizeBatch(exec) {
  const results = exec?.results;
  if (!Array.isArray(results)) return "已提交执行。";
  const ok = results.filter((r) => r?.ok).length;
  const fail = results.length - ok;
  if (!fail) return `已提交执行（${ok}/${results.length} 成功入队）。`;
  return `已提交执行（成功 ${ok}，失败 ${fail}）。`;
}

function withConfirmationHint(text) {
  const t = String(text || "").trim();
  if (!t) return "请回复“确认”开始执行，或回复“取消”。";
  if (/(确认|取消)/.test(t)) return t;
  return `${t}\n\n请回复“确认”开始执行，或回复“取消”。`;
}

function normalizePlanType(t) {
  const v = String(t || "").trim().toLowerCase();
  if (!v) return "";
  if (v === "exec" || v === "run") return "execute";
  if (v === "ask" || v === "question") return "clarify";
  if (v === "answer") return "query";
  return v;
}

function decideExecutionMode({ config, planType }) {
  const mode = String(config?.executionMode || "auto").trim().toLowerCase();
  if (mode === "always_confirm") return false;
  if (mode === "always_execute") return true;

  if (planType === "clarify") return false;
  if (planType === "propose") return false;
  return true;
}

function captureFacts({ name, args, result, facts }) {
  if (!facts) return;
  if (name === "devices.list") {
    facts.devicesList = result;
  }
  if (name === "devices.state") {
    const id = String(args?.id || "").trim();
    if (id) facts.deviceStates.set(id, result);
  }
}

function buildFallbackAnswer({ input, facts }) {
  if (!facts?.deviceStates || facts.deviceStates.size === 0) return null;

  const text = String(input || "").trim();
  const preferredId = inferPreferredDeviceId({ text, facts });
  const stateObj = preferredId ? facts.deviceStates.get(preferredId) : facts.deviceStates.values().next().value;
  const deviceId = preferredId || stateObj?.id;
  const switchState = stateObj?.traits?.switch?.state;
  if (!deviceId || !switchState) return null;

  const on = String(switchState).toLowerCase() === "on";
  if (/烧|煮|开水|热水/.test(text)) {
    return on
      ? `从系统可观测到：${deviceId} 正在供电（开）。这通常表示水壶在加热/可能正在烧水；若要判断“水是否已开/温度”，需要功率/温度等传感器。`
      : `从系统可观测到：${deviceId} 当前未供电（关），所以应该没有在烧水。`;
  }

  return `从系统可观测到：${deviceId} 当前开关状态为 ${on ? "开" : "关"}。`;
}

function inferPreferredDeviceId({ text, facts }) {
  const list = facts?.devicesList?.items;
  if (!Array.isArray(list) || list.length === 0) return null;

  // If only one device has a state, prefer it.
  if (facts.deviceStates.size === 1) return [...facts.deviceStates.keys()][0];

  const q = normalize(text);
  for (const d of list) {
    const id = normalize(d?.id);
    const name = normalize(d?.name);
    const aliases = Array.isArray(d?.semantics?.aliases) ? d.semantics.aliases.map(normalize) : [];
    if ((id && q.includes(id)) || (name && q.includes(name)) || aliases.some((a) => a && q.includes(a))) {
      if (facts.deviceStates.has(d.id)) return d.id;
    }
  }
  return null;
}

function stableStringify(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortDeep(value[k]);
    }
    return out;
  }
  return value;
}

function normalize(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}
