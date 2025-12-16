import test from "node:test";
import assert from "node:assert/strict";
import { buildApp, parseIntent } from "../src/index.js";

const devices = [
  { id: "light_living", name: "客厅灯", capabilities: [{ action: "turn_on" }, { action: "set_brightness" }] },
  { id: "ac_bed", name: "卧室空调", placement: { room: "bedroom" }, capabilities: [{ action: "set_temperature" }, { action: "set_hvac_mode" }] }
];

test("parseIntent detects brightness and device", () => {
  const { intent, candidates } = parseIntent({ input: "把客厅灯调到30%", devices });
  assert.equal(intent.action, "set_brightness");
  assert.equal(intent.deviceId, "light_living");
  assert.equal(intent.params.brightness, 30);
  assert.ok(intent.confidence > 0.5);
  assert.ok(Array.isArray(candidates));
});

test("parseIntent detects temperature/cool", () => {
  const { intent } = parseIntent({ input: "卧室空调调到24度制冷", devices });
  assert.equal(intent.action, "set_temperature");
  assert.equal(intent.deviceId, "ac_bed");
  assert.equal(intent.params.temperature, 24);
  assert.equal(intent.params.mode, "cool");
  assert.ok(intent.summary.includes("room=bedroom"));
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

test("parseIntent picks room-matching device when names absent", () => {
  const { intent } = parseIntent({
    input: "卧室开灯",
    devices: [
      { id: "light1", name: "客厅灯", placement: { room: "living_room" }, capabilities: [{ action: "turn_on" }] },
      { id: "light2", name: "顶灯", placement: { room: "bedroom" }, capabilities: [{ action: "turn_on" }] }
    ]
  });
  assert.equal(intent.deviceId, "light2");
  assert.equal(intent.action, "turn_on");
});

test("parseIntent can use messages fallback", () => {
  const { intent } = parseIntent({
    input: "",
    devices,
    messages: [
      { role: "user", content: "打开客厅灯" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "调亮度到40%" }
    ]
  });
  assert.equal(intent.action, "set_brightness");
  assert.equal(intent.params.brightness, 40);
});

test("parseIntent can match device by semantics aliases", () => {
  const { intent } = parseIntent({
    input: "打开烧水壶",
    devices: [
      {
        id: "kettle_plug",
        name: "烧水壶插座",
        placement: { room: "kitchen" },
        semantics: { aliases: ["烧水壶", "水壶"] },
        capabilities: [{ action: "turn_on" }, { action: "turn_off" }]
      },
      { id: "light1", name: "客厅灯", placement: { room: "living_room" }, capabilities: [{ action: "turn_on" }] }
    ]
  });
  assert.equal(intent.deviceId, "kettle_plug");
  assert.equal(intent.action, "turn_on");
});
