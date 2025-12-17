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

async function main() {
  const config = loadConfig();

  const mcpServer = buildMcpServer({ config });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.url?.startsWith("/mcp")) {
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await mcpServer.connect(transport);

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
