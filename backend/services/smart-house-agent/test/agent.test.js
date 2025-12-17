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
        { name: "devices.get", description: "get", inputSchema: { type: "object" } },
        { name: "devices.state", description: "state", inputSchema: { type: "object" } },
        { name: "devices.invoke", description: "invoke", inputSchema: { type: "object" } },
        { name: "actions.batch_invoke", description: "batch", inputSchema: { type: "object" } }
      ]
    }),
    callTool: async (name, args) => {
      calls.push({ name, args });
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
  assert.equal(mcp.calls[0].name, "devices.state");
  assert.equal(mcp.calls.length, 1);
  assert.equal(llm.calls.length, 2);
});

test("agent dedupes repeated tool calls with identical args", async () => {
  const sessionStore = createSessionStore({ config: { ...baseConfig, redisUrl: "" } });
  const mcp = makeMcpStub({
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
});
