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
  assert.ok(names.has("devices.get"));
  assert.ok(names.has("devices.state"));
  assert.ok(names.has("devices.invoke"));
  assert.ok(names.has("actions.batch_invoke"));
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

