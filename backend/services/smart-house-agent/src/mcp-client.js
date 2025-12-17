import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function createMcpClient({ config, logger }) {
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl));
  const client = new Client(
    { name: "smart-house-agent", version: "0.1.0" },
    { capabilities: {} }
  );

  client.onerror = (err) => logger?.warn?.({ msg: "MCP client error", error: err?.message || String(err) });

  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    client.cacheToolMetadata(tools);
  } catch (err) {
    logger?.warn?.({ msg: "Failed to cache MCP tool metadata", error: err?.message || String(err) });
  }

  async function callTool(name, args) {
    const result = await client.callTool({ name, arguments: args || {} });
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = result?.content?.[0]?.text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return {
    listTools: () => client.listTools(),
    callTool
  };
}

