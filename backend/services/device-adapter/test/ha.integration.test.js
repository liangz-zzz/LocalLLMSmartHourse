import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { DeviceAdapter } from "../src/adapter.js";
import { MemoryStore } from "../src/store.js";
import { Logger } from "../src/log.js";

test("adapter in ha mode discovers entities and applies state_changed updates", async () => {
  const initialStates = [
    {
      entity_id: "cover.living_room_curtain",
      state: "open",
      attributes: { friendly_name: "客厅窗帘", current_position: 30 }
    },
    {
      entity_id: "sensor.outdoor_temp",
      state: "12.3",
      attributes: { friendly_name: "室外温度", unit_of_measurement: "°C" }
    }
  ];

  const ha = await createMockHa({ token: "dummy", states: initialStates });
  const store = new MemoryStore();
  const adapter = new DeviceAdapter({
    mode: "ha",
    mqttUrl: "mqtt://invalid",
    store,
    logger: new Logger("error"),
    mockDataDir: "",
    deviceConfigPath: "",
    haBaseUrl: ha.baseUrl,
    haToken: "dummy",
    haIncludeDomains: ["cover"],
    haWsEnabled: true
  });

  await adapter.start();

  const first = await waitFor(async () => store.get("cover.living_room_curtain"), 2000);
  assert.equal(first.name, "客厅窗帘");
  assert.equal(first.protocol, "virtual");
  assert.equal(first.bindings.ha.entity_id, "cover.living_room_curtain");
  assert.equal(first.traits.cover.position, 30);
  assert.ok(first.capabilities.find((c) => c.action === "set_cover_position"));

  ha.emitStateChanged({
    entity_id: "cover.living_room_curtain",
    state: "open",
    attributes: { friendly_name: "客厅窗帘", current_position: 70 }
  });

  const updated = await waitFor(async () => {
    const d = await store.get("cover.living_room_curtain");
    if (d?.traits?.cover?.position === 70) return d;
    return null;
  }, 2000);
  assert.equal(updated.traits.cover.position, 70);

  await adapter.stop();
  await ha.close();
});

test("adapter in ha mode filters by include/exclude domains", async () => {
  const initialStates = [
    { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "厨房灯", brightness: 128 } },
    { entity_id: "switch.kettle", state: "off", attributes: { friendly_name: "烧水壶插座" } }
  ];

  const ha = await createMockHa({ token: "dummy", states: initialStates });
  const store = new MemoryStore();
  const adapter = new DeviceAdapter({
    mode: "ha",
    mqttUrl: "mqtt://invalid",
    store,
    logger: new Logger("error"),
    mockDataDir: "",
    deviceConfigPath: "",
    haBaseUrl: ha.baseUrl,
    haToken: "dummy",
    haIncludeDomains: ["light", "switch"],
    haExcludeDomains: ["switch"],
    haWsEnabled: false
  });

  await adapter.start();

  const light = await waitFor(async () => store.get("light.kitchen"), 2000);
  assert.ok(light);
  assert.equal(light.traits.switch.state, "on");
  assert.ok(light.capabilities.find((c) => c.action === "set_brightness"));

  const missingSwitch = await store.get("switch.kettle");
  assert.equal(missingSwitch, undefined);

  await adapter.stop();
  await ha.close();
});

async function createMockHa({ token, states }) {
  const services = [];
  const conns = new Set();
  const subsByConn = new Map();

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/states") {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(states));
      return;
    }

    const match = req.url?.match(/^\/api\/services\/([^/]+)\/([^/]+)$/);
    if (req.method === "POST" && match) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        services.push({ domain: match[1], service: match[2], body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const wss = new WebSocketServer({ server, path: "/api/websocket" });
  wss.on("connection", (ws) => {
    conns.add(ws);
    ws.send(JSON.stringify({ type: "auth_required", ha_version: "2025.1.0" }));
    ws.on("message", (data) => {
      const msg = safeParse(data);
      if (!msg) return;
      if (msg.type === "auth") {
        const ok = msg.access_token === token;
        ws.send(JSON.stringify(ok ? { type: "auth_ok", ha_version: "2025.1.0" } : { type: "auth_invalid", message: "invalid token" }));
        return;
      }
      if (msg.type === "subscribe_events" && msg.event_type === "state_changed") {
        subsByConn.set(ws, msg.id);
        ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: null }));
      }
      if (msg.type === "pong") return;
    });
    ws.on("close", () => {
      conns.delete(ws);
      subsByConn.delete(ws);
    });
  });

  const emitStateChanged = (newState) => {
    for (const ws of conns) {
      const id = subsByConn.get(ws);
      if (!id) continue;
      ws.send(
        JSON.stringify({
          id,
          type: "event",
          event: {
            event_type: "state_changed",
            data: { entity_id: newState.entity_id, old_state: null, new_state: newState }
          }
        })
      );
    }
  };

  const close = async () => {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  };

  return { baseUrl, emitStateChanged, services, close };
}

function safeParse(data) {
  try {
    const s = typeof data === "string" ? data : data.toString("utf8");
    return JSON.parse(s);
  } catch (_e) {
    return undefined;
  }
}

async function waitFor(fn, timeoutMs = 2000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timeout");
}

