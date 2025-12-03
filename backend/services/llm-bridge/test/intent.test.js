import test from "node:test";
import assert from "node:assert/strict";
import { buildApp, parseIntent } from "../src/index.js";

const devices = [
  { id: "light_living", name: "客厅灯", capabilities: [{ action: "turn_on" }, { action: "set_brightness" }] },
  { id: "ac_bed", name: "卧室空调", capabilities: [{ action: "set_temperature" }, { action: "set_hvac_mode" }] }
];

test("parseIntent detects brightness and device", () => {
  const intent = parseIntent("把客厅灯调到30%", devices);
  assert.equal(intent.action, "set_brightness");
  assert.equal(intent.deviceId, "light_living");
  assert.equal(intent.params.brightness, 30);
  assert.ok(intent.confidence > 0.5);
});

test("parseIntent detects temperature/cool", () => {
  const intent = parseIntent("卧室空调调到24度制冷", devices);
  assert.equal(intent.action, "set_temperature");
  assert.equal(intent.deviceId, "ac_bed");
  assert.equal(intent.params.temperature, 24);
  assert.equal(intent.params.mode, "cool");
});

test("intent route returns structured intent", async () => {
  const app = buildApp();
  await app.listen({ port: 0 });
  const port = app.server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "打开客厅灯", devices })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intent.deviceId, "light_living");
  assert.equal(body.intent.action, "turn_on");
  await app.close();
});
