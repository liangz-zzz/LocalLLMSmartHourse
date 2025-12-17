import http from "node:http";
import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { buildTools, callTool } from "./tools.js";
import { loadConfig } from "./config.js";

export function buildMcpServer({ config }) {
  const server = new Server(
    { name: "smart-house-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: buildTools({ config }) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params || {};
    return callTool({ name, args: args || {}, config });
  });

  return server;
}

function getHeader(req, name) {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] || "";
  return v || "";
}

function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

function looksLikeInitializeMessage(raw) {
  const messages = Array.isArray(raw) ? raw : [raw];
  return messages.some((m) => m && typeof m === "object" && m.method === "initialize");
}

const SESSION_TTL_MS = Number(process.env.MCP_SESSION_TTL_MS || 60 * 60 * 1000);
const sessions = new Map(); // sessionId -> { transport, server, lastSeen }

async function pruneSessions() {
  const now = Date.now();
  for (const [sessionId, sess] of sessions.entries()) {
    if (!sess?.lastSeen || now - sess.lastSeen <= SESSION_TTL_MS) continue;
    sessions.delete(sessionId);
    try {
      await sess.transport.close();
    } catch {
      // ignore
    }
  }
}

async function createSession({ config }) {
  const sessionId = randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId
  });
  const mcpServer = buildMcpServer({ config });
  await mcpServer.connect(transport);
  return { sessionId, transport, server: mcpServer, lastSeen: Date.now() };
}

async function main() {
  const config = loadConfig();

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      sendJson(res, 200, { status: "ok", sessions: sessions.size });
      return;
    }

    if (req.url?.startsWith("/mcp")) {
      await pruneSessions();
      const mcpSessionId = String(getHeader(req, "mcp-session-id") || "").trim();

      if (!mcpSessionId) {
        if (req.method !== "POST") {
          sendJson(res, 400, { error: "mcp_session_required" });
          return;
        }

        let parsedBody;
        try {
          parsedBody = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: "invalid_json", message: err?.message || String(err) });
          return;
        }

        if (!looksLikeInitializeMessage(parsedBody)) {
          sendJson(res, 400, { error: "bad_request", message: "missing mcp-session-id (initialize required)" });
          return;
        }

        const session = await createSession({ config });
        sessions.set(session.sessionId, session);
        session.transport.onclose = () => sessions.delete(session.sessionId);
        session.transport.onerror = () => {};

        try {
          await session.transport.handleRequest(req, res, parsedBody);
        } catch (err) {
          sessions.delete(session.sessionId);
          try {
            await session.transport.close();
          } catch {
            // ignore
          }
          sendJson(res, 500, { error: "mcp_transport_error", message: err?.message || String(err) });
        }
        return;
      }

      const session = sessions.get(mcpSessionId);
      if (!session) {
        sendJson(res, 404, { error: "session_not_found" });
        return;
      }
      session.lastSeen = Date.now();

      try {
        await session.transport.handleRequest(req, res);
      } catch (err) {
        sendJson(res, 500, { error: "mcp_transport_error", message: err?.message || String(err) });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  httpServer.listen(config.port, "0.0.0.0", () => {
    console.log(`smart-house-mcp-server listening on :${config.port} (mcp=/mcp)`);
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
