import { randomUUID } from "node:crypto";

const MAX_ITERATIONS = 8;
const WRITE_TOOLS = new Set(["devices.invoke", "actions.batch_invoke"]);
const MAX_TOOL_CALLS_PER_TURN = 16;

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
        rememberExecution(session, { planId: pending.planId, actions: pending.actions, ok: !isToolError(exec), message: text });
        rememberLastDevice(session, { deviceId: pending.actions?.[0]?.deviceId });
        appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
        appendMessage(session, { role: "assistant", content: text }, config.maxMessages);
        await sessionStore.save(session);

        if (isToolError(exec) || !Array.isArray(exec?.results)) {
          return {
            traceId,
            sessionId: session.id,
            type: "error",
            error: isToolError(exec) ? exec.error : "batch_invoke_failed",
            planId: pending.planId,
            actions: pending.actions,
            result: exec,
            message: text
          };
        }

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
    let deviceInventory = null;

    // Strategy A: Always preload the full device list so the model can ground
    // deviceId selection and avoid hallucinating non-existent ids.
    {
      const name = "devices.list";
      const args = {};
      const safeArgs = enforcePolicy({ name, args, allowWrite: false });
      const key = `${name}:${stableStringify(safeArgs)}`;
      toolCallKeys.add(key);
      toolCalls.push({ name, args: safeArgs });

      let result;
      try {
        result = await mcp.callTool(name, safeArgs);
      } catch (err) {
        result = { error: "tool_execution_failed", message: err?.message || String(err) };
      }
      deviceInventory = !isToolError(result) ? result : null;
      toolCache.set(key, result);
      messages.push({ role: "system", content: toolResultMessage({ name, result }) });
      messages.push({
        role: "system",
        content: JSON.stringify({
          device_inventory_loaded: true,
          instruction:
            "Use ONLY deviceId values present in the devices.list result above. Never invent device ids. If no device matches the user request, ask a clarifying question (plan.type=clarify)."
        })
      });

      if (isToolError(result)) {
        const msg = `无法获取设备列表（${result.error}）：${String(result.message || "").trim() || "unknown error"}。`;
        appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
        appendMessage(session, { role: "assistant", content: msg }, config.maxMessages);
        await sessionStore.save(session);
        return { traceId, sessionId: session.id, type: "error", error: "devices_list_failed", message: msg, toolCalls };
      }
    }

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
            if (toolCalls.length >= MAX_TOOL_CALLS_PER_TURN) break;
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

          if (!isToolError(result)) {
            if (name === "devices.get" || name === "devices.state") {
              const id = String(safeArgs?.id || result?.id || "").trim();
              rememberLastDevice(session, { deviceId: id, inventory: deviceInventory, from: name });
            }
            if (name === "devices.invoke") {
              const id = String(safeArgs?.deviceId || "").trim();
              rememberLastDevice(session, { deviceId: id, inventory: deviceInventory, from: name });
            }
          }

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
            rememberLastDevice(session, {
              deviceId: actions?.[0]?.deviceId,
              inventory: deviceInventory,
              requireInventory: true,
              from: "plan"
            });
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
              summarizeDryrunFailure({ dryrun, actions }) ||
              "我无法确定要执行的动作是否都可用（设备不存在/能力不支持/参数不完整）。你能确认一下要控制的设备或动作吗？";
            appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
            appendMessage(session, { role: "assistant", content: msg }, config.maxMessages);
            rememberExecution(session, { planId, actions, ok: false, message: msg });
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
          rememberExecution(session, { planId, actions, ok: !isToolError(exec), message: msg });
          rememberLastDevice(session, {
            deviceId: actions?.[0]?.deviceId,
            inventory: deviceInventory,
            requireInventory: true,
            from: "execute"
          });
          appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
          appendMessage(session, { role: "assistant", content: msg }, config.maxMessages);
          await sessionStore.save(session);

          if (isToolError(exec) || !Array.isArray(exec?.results)) {
            return {
              traceId,
              sessionId: session.id,
              type: "error",
              error: isToolError(exec) ? exec.error : "batch_invoke_failed",
              planId,
              actions,
              result: exec,
              message: msg,
              toolCalls
            };
          }

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

    const toolResults = toolCalls.map((c) => {
      const key = `${c.name}:${stableStringify(c.args)}`;
      return { name: c.name, args: c.args, result: toolCache.get(key) };
    });

    const fallback = `LLM 在 ${MAX_ITERATIONS} 轮内未产出最终结果（final）。这是当前真实状态：模型未完成决策；已执行工具调用与结果已返回。`;
    appendMessage(session, { role: "user", content: trimmed }, config.maxMessages);
    appendMessage(session, { role: "assistant", content: fallback }, config.maxMessages);
    await sessionStore.save(session);
    return {
      traceId,
      sessionId: session.id,
      type: "error",
      error: "llm_no_final",
      message: fallback,
      iterations: MAX_ITERATIONS,
      toolCalls,
      toolResults
    };
  }

  return { turn };
}

function buildSystemPrompt({ toolsText }) {
  return [
    "You are Smart House Agent.",
    "You MUST use tools to get facts about devices/state/capabilities. Do not assume.",
    "You MUST output ONLY valid JSON (no markdown, no extra text).",
    "Tool results arrive as system JSON messages: {\"tool_result\":{\"name\":\"...\",\"result\":{...}}}.",
    "At the start of each turn, you will receive a devices.list tool_result containing the available devices and their ids. Treat it as the source of truth.",
    "",
    "Available MCP tools:",
    toolsText,
    "",
    "Output formats:",
    '1) Tool calls: {"type":"tool_calls","tool_calls":[{"name":"devices.list","arguments":{}}]}',
    '2) Final: {"type":"final","assistant":"...","plan":{"planId":"...","type":"query|execute|propose|clarify","actions":[{"deviceId":"...","action":"turn_on|turn_off|...","params":{}}]}}',
    "",
    "Rules:",
    "- NEVER invent device ids. deviceId must come from devices.list (or devices.get). If no match, ask a clarifying question.",
    '- If the user refers implicitly (e.g., "好了，可以关了") and CONTEXT_JSON.lastDevice.id is set, treat that as the target device.',
    "- If the user asks about current state, call devices.state/devices.get first.",
    "- For clear control commands, return plan.type=execute with plan.actions.",
    "- If you want the user to confirm first (uncertainty/high impact), return plan.type=propose with plan.actions.",
    "- If unclear, return plan.type=clarify and ask a concise clarifying question in assistant.",
    "- Do NOT call the same tool with identical arguments more than once per turn."
  ].join("\n");
}

function buildContextPrompt({ session }) {
  const pending = session.state?.pending ? { planId: session.state.pending.planId, actions: session.state.pending.actions } : null;
  const lastDevice =
    session.state?.lastDeviceId || session.state?.lastDeviceName || session.state?.lastRoom
      ? { id: session.state?.lastDeviceId || null, name: session.state?.lastDeviceName || null, room: session.state?.lastRoom || null }
      : null;
  const ctx = {
    sessionId: session.id,
    lastDevice,
    lastExecution: session.state?.lastExecution || null,
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
  if (isToolError(exec)) {
    const msg = String(exec?.message || "").trim();
    return msg ? `执行失败（${exec.error}）：${msg}` : `执行失败（${exec.error}）。`;
  }
  const results = exec?.results;
  if (!Array.isArray(results)) return "执行失败：上游未返回批量执行结果（results）。";
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

function isToolError(v) {
  return v && typeof v === "object" && !Array.isArray(v) && typeof v.error === "string";
}

function rememberLastDevice(session, { deviceId, inventory, requireInventory } = {}) {
  const id = String(deviceId || "").trim();
  if (!id) return;

  const device = findDeviceInInventory(inventory, id);
  if (requireInventory && inventory && !device) return;

  if (!session.state || typeof session.state !== "object") session.state = {};
  session.state.lastDeviceId = id;
  if (device) {
    session.state.lastDeviceName = device.name || session.state.lastDeviceName || null;
    session.state.lastRoom = device.placement?.room || session.state.lastRoom || null;
  }
}

function rememberExecution(session, { planId, actions, ok, message } = {}) {
  if (!session.state || typeof session.state !== "object") session.state = {};
  session.state.lastExecution = {
    planId: planId ? String(planId) : null,
    ok: Boolean(ok),
    actions: Array.isArray(actions) ? actions : [],
    message: String(message || "").trim() || null,
    ts: Date.now()
  };
}

function findDeviceInInventory(inventory, id) {
  const list = inventory?.items;
  if (!Array.isArray(list)) return null;
  return list.find((d) => d && typeof d === "object" && d.id === id) || null;
}

function summarizeDryrunFailure({ dryrun, actions }) {
  if (isToolError(dryrun)) {
    const ids = Array.from(new Set((actions || []).map((a) => a?.deviceId).filter(Boolean)));
    const target = ids.length ? `设备 ${ids.join(", ")} ` : "";
    const detail = String(dryrun?.message || "").trim() || dryrun.error;
    return `无法执行：${target}${detail}。请确认要控制的设备/动作是否正确。`;
  }

  const results = dryrun?.results;
  if (!Array.isArray(results)) return null;
  const failures = results.filter((r) => !r?.ok);
  if (!failures.length) return null;

  const first = failures[0];
  const where = [first?.deviceId, first?.action].filter(Boolean).join(" ");
  const err = first?.result?.error || first?.error;
  const msg = first?.result?.message || first?.message;
  const detail = [err, msg].filter(Boolean).join("：");
  return `无法执行：${where || "动作校验失败"}${detail ? `（${detail}）` : ""}。请确认要控制的设备/动作是否正确。`;
}

function decideExecutionMode({ config, planType }) {
  const mode = String(config?.executionMode || "auto").trim().toLowerCase();
  if (mode === "always_confirm") return false;
  if (mode === "always_execute") return true;

  if (planType === "clarify") return false;
  if (planType === "propose") return false;
  return true;
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
