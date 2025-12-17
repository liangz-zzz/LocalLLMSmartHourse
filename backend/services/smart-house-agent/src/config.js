function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export function loadConfig() {
  const sessionTtlMs = num("SESSION_TTL_MS", 60 * 60 * 1000);
  const maxMessages = num("SESSION_MAX_MESSAGES", 30);
  return {
    port: num("PORT", 6000),
    llmApiBase: (process.env.LLM_API_BASE || "http://llm-bridge:5000/v1").replace(/\/$/, ""),
    llmApiKey: process.env.LLM_API_KEY || "",
    agentModel: process.env.AGENT_MODEL || "deepseek-chat",
    mcpUrl: (process.env.MCP_URL || "http://smart-house-mcp-server:7000/mcp").replace(/\/$/, ""),
    redisUrl: (process.env.REDIS_URL || "").trim(),
    sessionTtlMs,
    maxMessages
  };
}

