import test from "node:test";
import assert from "node:assert/strict";

import { createAgent } from "../src/smart-house-agent.js";
import { createSessionStore } from "../src/session-store.js";

function makeLlmStub(responses) {
  const queue = [...responses];
  const calls = [];
  return {
    calls,
    chat: async ({ messages }) => {
      calls.push(messages);
      const next = queue.shift();
      if (!next) throw new Error("LLM stub exhausted");
      return { choices: [{ message: { content: JSON.stringify(next) } }] };
    }
  };
}

function makeMcpStub(impl = {}) {
  const calls = [];
  return {
    calls,
    listTools: async () => ({
      tools: [
        { name: "devices.list", description: "list", inputSchema: { type: "object" } },
        { name: "scenes.list", description: "scenes", inputSchema: { type: "object" } },
        { name: "devices.get", description: "get", inputSchema: { type: "object" } },
        { name: "devices.state", description: "state", inputSchema: { type: "object" } },
        { name: "devices.invoke", description: "invoke", inputSchema: { type: "object" } },
        { name: "actions.batch_invoke", description: "batch", inputSchema: { type: "object" } }
      ]
    }),
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "devices.list" && !impl[name]) return { items: [], count: 0 };
      if (name === "scenes.list" && !impl[name]) return { items: [], count: 0 };
      if (impl[name]) return impl[name](args);
      throw new Error(`Unhandled tool: ${name}`);
    }
  };
}

const baseConfig = {
  agentModel: "test-model",
  maxMessages: 30,
  sessionTtlMs: 60_000,
  executionMode: "auto"
};

test("agent can answer a state query via tool_calls", async () => {
  const sessionStore = createSessionStore({ config: { ...baseConfig, redisUrl: "" } });
  const mcp = makeMcpStub({
    "devices.list": async () => ({
      items: [{ id: "kettle_plug", name: "烧水壶插座", placement: { room: "kitchen" } }],
      count: 1
    }),
    "devices.state": async () => ({ id: "kettle_plug", traits: { switch: { state: "on" } } })
  });
  const llm = makeLlmStub([
    { type: "tool_calls", tool_calls: [{ name: "devices.state", arguments: { id: "kettle_plug" } }] },
    { type: "final", assistant: "烧水壶正在供电（开）。", plan: { type: "query", actions: [] } }
  ]);

  const agent = createAgent({ config: baseConfig, sessionStore, mcp, llm });
  const out = await agent.turn({ sessionId: "s1", input: "水在烧了么", confirm: false });

  assert.equal(out.type, "answer");
  assert.equal(out.message, "烧水壶正在供电（开）。");
  assert.equal(mcp.calls[0].name, "devices.list");
  assert.equal(mcp.calls[1].name, "scenes.list");
  assert.equal(mcp.calls[2].name, "devices.state");
  assert.equal(mcp.calls.length, 3);
  assert.equal(llm.calls.length, 2);
});

test("agent persists lastDevice and exposes it in CONTEXT_JSON for follow-ups", async () => {
  const sessionStore = createSessionStore({ config: { ...baseConfig, redisUrl: "" } });
  const mcp = makeMcpStub({
    "devices.list": async () => ({
      items: [{ id: "kettle_plug", name: "烧水壶插座", placement: { room: "kitchen" } }],
      count: 1
    }),
    "devices.state": async () => ({ id: "kettle_plug", traits: { switch: { state: "on" } } })
  });
  const llm = makeLlmStub([
    { type: "tool_calls", tool_calls: [{ name: "devices.state", arguments: { id: "kettle_plug" } }] },
    { type: "final", assistant: "烧水壶正在供电（开）。", plan: { type: "query", actions: [] } },
    { type: "final", assistant: "好的。", plan: { type: "query", actions: [] } }
  ]);

  const agent = createAgent({ config: baseConfig, sessionStore, mcp, llm });
  await agent.turn({ sessionId: "s_mem", input: "水在烧了么", confirm: false });

  const stored = await sessionStore.getOrCreate("s_mem");
  assert.equal(stored.state.lastDeviceId, "kettle_plug");
  assert.equal(stored.state.lastDeviceName, "烧水壶插座");
  assert.equal(stored.state.lastRoom, "kitchen");

  await agent.turn({ sessionId: "s_mem", input: "好了，可以关了", confirm: false });
  assert.equal(llm.calls.length, 3);

  const secondTurnMessages = llm.calls[2];
  const ctxMsg = secondTurnMessages.find((m) => m.role === "system" && String(m.content || "").startsWith("CONTEXT_JSON="));
  assert.ok(ctxMsg, "CONTEXT_JSON should be present");
  const ctx = JSON.parse(String(ctxMsg.content).slice("CONTEXT_JSON=".length));
  assert.equal(ctx.lastDevice.id, "kettle_plug");
  assert.equal(ctx.lastDevice.name, "烧水壶插座");
  assert.equal(ctx.lastDevice.room, "kitchen");
});

test("agent dedupes repeated tool calls with identical args", async () => {
  const sessionStore = createSessionStore({ config: { ...baseConfig, redisUrl: "" } });
  const mcp = makeMcpStub({
    "devices.list": async () => ({
      items: [{ id: "kettle_plug", name: "烧水壶插座", placement: { room: "kitchen" } }],
      count: 1
    }),
    "devices.state": async () => ({ id: "kettle_plug", traits: { switch: { state: "off" } } })
  });
  const llm = makeLlmStub([
    { type: "tool_calls", tool_calls: [{ name: "devices.state", arguments: { id: "kettle_plug" } }] },
    { type: "tool_calls", tool_calls: [{ name: "devices.state", arguments: { id: "kettle_plug" } }] },
    { type: "final", assistant: "烧水壶插座是关闭状态。", plan: { type: "query", actions: [] } }
  ]);

  const agent = createAgent({ config: baseConfig, sessionStore, mcp, llm });
  const out = await agent.turn({ sessionId: "s_dedupe", input: "热水在烧了么", confirm: false });

  assert.equal(out.type, "answer");
  assert.equal(mcp.calls.filter((c) => c.name === "devices.state").length, 1, "tool should be called once");
  assert.equal(Array.isArray(out.toolCalls), true);
  assert.equal(out.toolCalls.filter((c) => c.name === "devices.state").length, 1, "toolCalls should be deduped");
});

test("agent returns llm_no_final with tool results when model never finalizes", async () => {
  const sessionStore = createSessionStore({ config: { ...baseConfig, redisUrl: "" } });
  const mcp = makeMcpStub({
    "devices.list": async () => ({
      items: [{ id: "kettle_plug", name: "烧水壶插座", placement: { room: "kitchen" } }],
      count: 1
    }),
    "devices.state": async () => ({ id: "kettle_plug", traits: { switch: { state: "off" } } })
  });

  const responses = Array.from({ length: 8 }, () => ({
    type: "tool_calls",
    tool_calls: [{ name: "devices.state", arguments: { id: "kettle_plug" } }]
  }));
  const llm = makeLlmStub(responses);

  const agent = createAgent({ config: baseConfig, sessionStore, mcp, llm });
  const out = await agent.turn({ sessionId: "s_no_final", input: "热水在烧了么", confirm: false });

  assert.equal(out.type, "error");
  assert.equal(out.error, "llm_no_final");
  assert.equal(out.iterations, 8);
  assert.equal(mcp.calls.filter((c) => c.name === "devices.state").length, 1, "tool should be called once due to cache");
  assert.equal(out.toolCalls.filter((c) => c.name === "devices.state").length, 1);
  assert.equal(out.toolResults.length, 3);
  assert.ok(out.toolResults.some((r) => r.name === "devices.list"));
  assert.ok(out.toolResults.some((r) => r.name === "scenes.list"));
  assert.ok(out.toolResults.some((r) => r.name === "devices.state"));
});

test("agent proposes actions then executes on confirmation", async () => {
  const sessionStore = createSessionStore({ config: { ...baseConfig, redisUrl: "" } });
  const mcp = makeMcpStub({
    "actions.batch_invoke": async (args) => {
      assert.equal(args.confirm, true);
      assert.equal(args.dryRun, false);
      assert.equal(Array.isArray(args.actions), true);
      return { results: [{ ok: true }] };
    }
  });
  const llm = makeLlmStub([
    {
      type: "final",
      assistant: "我将关闭烧水壶插座。请确认。",
      plan: { planId: "p1", type: "propose", actions: [{ deviceId: "kettle_plug", action: "turn_off", params: {} }] }
    }
  ]);

  const agent = createAgent({ config: baseConfig, sessionStore, mcp, llm });

  const propose = await agent.turn({ sessionId: "s2", input: "关闭烧水壶", confirm: false });
  assert.equal(propose.type, "propose");
  assert.equal(propose.planId, "p1");
  assert.equal(propose.actions.length, 1);

  const exec = await agent.turn({ sessionId: "s2", input: "确认", confirm: false });
  assert.equal(exec.type, "executed");
  assert.equal(exec.planId, "p1");
  assert.equal(mcp.calls.at(-1).name, "actions.batch_invoke");
  assert.equal(llm.calls.length, 1, "LLM should not be called during confirmation execution");
});

test("agent auto-executes when plan.type=execute", async () => {
  const sessionStore = createSessionStore({ config: { ...baseConfig, redisUrl: "" } });
  const mcp = makeMcpStub({
    "actions.batch_invoke": async (args) => {
      if (args.dryRun) return { results: [{ ok: true }] };
      assert.equal(args.confirm, true);
      assert.equal(args.dryRun, false);
      return { results: [{ ok: true }] };
    }
  });
  const llm = makeLlmStub([
    {
      type: "final",
      assistant: "已为你打开烧水壶插座。",
      plan: { planId: "p2", type: "execute", actions: [{ deviceId: "kettle_plug", action: "turn_on", params: {} }] }
    }
  ]);

  const agent = createAgent({ config: baseConfig, sessionStore, mcp, llm });
  const out = await agent.turn({ sessionId: "s3", input: "打开烧水壶", confirm: false });

  assert.equal(out.type, "executed");
  assert.equal(out.planId, "p2");
  assert.equal(mcp.calls.filter((c) => c.name === "actions.batch_invoke").length, 2, "dryrun + execute");
  assert.equal(mcp.calls.filter((c) => c.name === "devices.list").length, 1, "bootstrap devices.list");
});

test("agent requires confirmation for medium/high risk voice actions", async () => {
  const sessionStore = createSessionStore({ config: { ...baseConfig, redisUrl: "" } });
  const mcp = makeMcpStub({
    "devices.list": async () => ({
      items: [
        {
          id: "voice_ac",
          name: "卧室空调",
          bindings: {
            voice_control: {
              actions: {
                set_temperature: { risk: "medium" }
              }
            }
          }
        }
      ],
      count: 1
    })
  });
  const llm = makeLlmStub([
    {
      type: "final",
      assistant: "已为你把卧室空调调到 18 度。",
      plan: { planId: "p_voice_risk", type: "execute", actions: [{ deviceId: "voice_ac", action: "set_temperature", params: { value: 18 } }] }
    }
  ]);

  const agent = createAgent({ config: baseConfig, sessionStore, mcp, llm });
  const out = await agent.turn({ sessionId: "s_voice_risk", input: "把卧室空调调到18度", confirm: false });

  assert.equal(out.type, "propose");
  assert.equal(out.planId, "p_voice_risk");
  assert.equal(mcp.calls.filter((c) => c.name === "actions.batch_invoke").length, 0, "should not auto execute medium/high voice risk");
  assert.match(out.message, /需先确认/);
});

test("agent surfaces batch_invoke errors during confirmation (no optimistic success)", async () => {
  const sessionStore = createSessionStore({ config: { ...baseConfig, redisUrl: "" } });
  const mcp = makeMcpStub({
    "actions.batch_invoke": async (args) => {
      assert.equal(args.confirm, true);
      assert.equal(args.dryRun, false);
      return { error: "tool_execution_failed", message: "upstream 500: boom" };
    }
  });
  const llm = makeLlmStub([
    {
      type: "final",
      assistant: "我将关闭烧水壶插座。请确认。",
      plan: { planId: "p_err1", type: "propose", actions: [{ deviceId: "kettle_plug", action: "turn_off", params: {} }] }
    }
  ]);

  const agent = createAgent({ config: baseConfig, sessionStore, mcp, llm });
  const propose = await agent.turn({ sessionId: "s_err1", input: "关闭烧水壶", confirm: false });
  assert.equal(propose.type, "propose");

  const exec = await agent.turn({ sessionId: "s_err1", input: "确认", confirm: false });
  assert.equal(exec.type, "error");
  assert.equal(exec.error, "tool_execution_failed");
  assert.match(exec.message, /执行失败/);
  assert.ok(!/已提交执行。$/.test(exec.message));
  assert.equal(llm.calls.length, 1, "LLM should not be called during confirmation execution");
});

test("agent surfaces batch_invoke errors during auto-execution (no optimistic success)", async () => {
  const sessionStore = createSessionStore({ config: { ...baseConfig, redisUrl: "" } });
  const mcp = makeMcpStub({
    "actions.batch_invoke": async (args) => {
      if (args.dryRun) return { results: [{ ok: true }] };
      assert.equal(args.confirm, true);
      assert.equal(args.dryRun, false);
      return { error: "tool_execution_failed", message: "upstream 502: bad gateway" };
    }
  });
  const llm = makeLlmStub([
    {
      type: "final",
      assistant: "已为你关闭烧水壶插座。",
      plan: { planId: "p_err2", type: "execute", actions: [{ deviceId: "kettle_plug", action: "turn_off", params: {} }] }
    }
  ]);

  const agent = createAgent({ config: baseConfig, sessionStore, mcp, llm });
  const out = await agent.turn({ sessionId: "s_err2", input: "关闭烧水壶", confirm: false });

  assert.equal(out.type, "error");
  assert.equal(out.error, "tool_execution_failed");
  assert.match(out.message, /执行失败/);
  assert.equal(mcp.calls.filter((c) => c.name === "actions.batch_invoke").length, 2, "dryrun + execute attempt");
});

test("agent ignores optimistic assistant text when dryrun fails", async () => {
  const sessionStore = createSessionStore({ config: { ...baseConfig, redisUrl: "" } });
  const mcp = makeMcpStub({
    "actions.batch_invoke": async (args) => {
      assert.equal(args.dryRun, true);
      return { error: "tool_execution_failed", message: "upstream 404: {\"error\":\"not_found\"}" };
    }
  });
  const llm = makeLlmStub([
    {
      type: "final",
      assistant: "好的，已为您关闭热水器。",
      plan: { planId: "p_dryfail", type: "execute", actions: [{ deviceId: "water_heater_001", action: "turn_off", params: {} }] }
    }
  ]);

  const agent = createAgent({ config: baseConfig, sessionStore, mcp, llm });
  const out = await agent.turn({ sessionId: "s_dryfail", input: "关闭热水器", confirm: false });

  assert.equal(out.type, "clarify");
  assert.match(out.message, /无法执行/);
  assert.ok(!out.message.includes("已为您关闭热水器"));
  assert.equal(mcp.calls.filter((c) => c.name === "actions.batch_invoke").length, 1, "only dryrun should run");
});
