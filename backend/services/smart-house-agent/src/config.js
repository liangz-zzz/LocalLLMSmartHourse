function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

export function loadConfig() {
  const sessionTtlMs = num("SESSION_TTL_MS", 60 * 60 * 1000);
  const maxMessages = num("SESSION_MAX_MESSAGES", 30);
  return {
    // Avoid 6000 (blocked by WHATWG "bad ports" in fetch implementations, e.g., X11).
    port: num("PORT", 6100),
    llmApiBase: (process.env.LLM_API_BASE || "http://llm-bridge:5000/v1").replace(/\/$/, ""),
    llmApiKey: process.env.LLM_API_KEY || "",
    agentModel: process.env.AGENT_MODEL || "deepseek-chat",
    mcpUrl: (process.env.MCP_URL || "http://smart-house-mcp-server:7000/mcp").replace(/\/$/, ""),
    redisUrl: (process.env.REDIS_URL || "").trim(),
    sessionTtlMs,
    maxMessages,
    executionMode: String(process.env.AGENT_EXECUTION_MODE || "auto").trim().toLowerCase(),
    prewarmEnabled: bool("AGENT_PREWARM_ENABLED", true),
    prewarmCacheTtlMs: num("AGENT_PREWARM_CACHE_TTL_MS", 30_000)
  };
}
