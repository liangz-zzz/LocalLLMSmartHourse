import test from "node:test";
import assert from "node:assert/strict";

import { buildTools, callTool } from "../src/tools.js";

const baseConfig = {
  port: 0,
  apiGatewayBase: "http://api-gateway:4000",
  apiGatewayApiKey: "",
  defaultDryRun: true
};

function parseToolResult(result) {
  const text = result?.content?.[0]?.text;
  assert.ok(typeof text === "string" && text.length > 0);
  return JSON.parse(text);
}

test("buildTools returns expected tool names", () => {
  const tools = buildTools();
  const names = new Set(tools.map((t) => t.name));
  assert.ok(names.has("devices.list"));
  assert.ok(names.has("scenes.list"));
  assert.ok(names.has("scenes.plan"));
  assert.ok(names.has("scenes.agent_run"));
  assert.ok(names.has("devices.get"));
  assert.ok(names.has("devices.resolve"));
  assert.ok(names.has("devices.state"));
  assert.ok(names.has("devices.invoke"));
  assert.ok(names.has("actions.batch_invoke"));
});

test("devices.list strips simulator source marker from vendor_extra", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith("/devices")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "sim_light_lr",
              name: "客厅模拟灯",
              placement: { room: "living_room" },
              protocol: "virtual",
              bindings: {
                vendor_extra: {
                  __simulator_source: true,
                  model_hint: "sim-v1"
                }
              },
              traits: {},
              capabilities: [{ action: "turn_on" }]
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("not_found", { status: 404 });
  };

  const result = await callTool({
    name: "devices.list",
    args: {},
    config: baseConfig
  });
  assert.ok(!result.isError);
  const body = parseToolResult(result);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].bindings.vendor_extra.__simulator_source, undefined);
  assert.equal(body.items[0].bindings.vendor_extra.model_hint, "sim-v1");

  global.fetch = originalFetch;
});

test("devices.invoke defaults to dry-run and returns next call hint", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/devices/kettle_plug")) {
      return new Response(
        JSON.stringify({ id: "kettle_plug", capabilities: [{ action: "turn_on" }, { action: "turn_off" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("not_found", { status: 404 });
  };

  const result = await callTool({
    name: "devices.invoke",
    args: { deviceId: "kettle_plug", action: "turn_on" },
    config: baseConfig
  });
  assert.ok(!result.isError);
  const body = parseToolResult(result);
  assert.equal(body.status, "dry_run_ok");
  assert.equal(body.next.tool, "devices.invoke");
  assert.equal(body.next.args.confirm, true);
  assert.equal(body.next.args.dryRun, false);

  global.fetch = originalFetch;
});

test("devices.invoke requires confirm=true when dryRun=false", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/devices/kettle_plug")) {
      return new Response(
        JSON.stringify({ id: "kettle_plug", capabilities: [{ action: "turn_on" }, { action: "turn_off" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("not_found", { status: 404 });
  };

  const result = await callTool({
    name: "devices.invoke",
    args: { deviceId: "kettle_plug", action: "turn_on", dryRun: false },
    config: { ...baseConfig, defaultDryRun: false }
  });
  assert.ok(result.isError);
  const body = parseToolResult(result);
  assert.equal(body.error, "confirmation_required");

  global.fetch = originalFetch;
});

test("devices.invoke can enqueue when confirm=true and dryRun=false", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes("/devices/kettle_plug/actions")) {
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ status: "queued" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).includes("/devices/kettle_plug")) {
      return new Response(
        JSON.stringify({ id: "kettle_plug", capabilities: [{ action: "turn_on" }, { action: "turn_off" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("not_found", { status: 404 });
  };

  const result = await callTool({
    name: "devices.invoke",
    args: { deviceId: "kettle_plug", action: "turn_on", dryRun: false, confirm: true },
    config: { ...baseConfig, defaultDryRun: false }
  });
  assert.ok(!result.isError);
  const body = parseToolResult(result);
  assert.equal(body.status, "queued");

  global.fetch = originalFetch;
});

test("devices.resolve can select by stableKey", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith("/devices")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "light1_v2",
              name: "客厅灯",
              identity: { stableKey: "stable_living_light" },
              placement: { room: "living_room" },
              semantics: { tags: ["light"], aliases: ["主灯"] },
              capabilities: [{ action: "turn_on" }, { action: "turn_off" }]
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("not_found", { status: 404 });
  };

  const result = await callTool({
    name: "devices.resolve",
    args: { stableKey: "stable_living_light", action: "turn_off" },
    config: baseConfig
  });
  assert.ok(!result.isError);
  const body = parseToolResult(result);
  assert.equal(body.count, 1);
  assert.equal(body.selected.id, "light1_v2");
  assert.equal(body.selected.identity.stableKey, "stable_living_light");

  global.fetch = originalFetch;
});

test("scenes.agent_run calls api-gateway agent-run endpoint", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes("/scenes/sleep/agent-run")) {
      assert.equal(init?.method, "POST");
      const payload = JSON.parse(String(init?.body || "{}"));
      assert.equal(payload.confirm, true);
      return new Response(
        JSON.stringify({
          runId: "r1",
          sceneId: "sleep",
          mode: "agentic",
          status: "ok",
          steps: [],
          startedAt: Date.now()
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("not_found", { status: 404 });
  };

  const result = await callTool({
    name: "scenes.agent_run",
    args: { sceneId: "sleep", dryRun: false, confirm: true },
    config: { ...baseConfig, defaultDryRun: false }
  });
  assert.ok(!result.isError);
  const body = parseToolResult(result);
  assert.equal(body.mode, "agentic");
  assert.equal(body.sceneId, "sleep");

  global.fetch = originalFetch;
});

test("scenes.plan calls api-gateway plan endpoint", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes("/scenes/sleep/plan")) {
      assert.equal(init?.method, "POST");
      return new Response(
        JSON.stringify({
          runId: "plan1",
          sceneId: "sleep",
          mode: "agentic",
          type: "plan",
          steps: []
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("not_found", { status: 404 });
  };

  const result = await callTool({
    name: "scenes.plan",
    args: { sceneId: "sleep" },
    config: baseConfig
  });
  assert.ok(!result.isError);
  const body = parseToolResult(result);
  assert.equal(body.type, "plan");
  assert.equal(body.sceneId, "sleep");

  global.fetch = originalFetch;
});
