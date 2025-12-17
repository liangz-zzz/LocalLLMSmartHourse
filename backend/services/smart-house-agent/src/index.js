import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { createSessionStore } from "./session-store.js";
import { createMcpClient } from "./mcp-client.js";
import { createLlmClient } from "./llm-client.js";
import { createAgent } from "./smart-house-agent.js";

function createLogger(level = "info") {
  const levels = ["error", "warn", "info", "debug"];
  const current = levels.includes(level) ? level : "info";
  const should = (lvl) => levels.indexOf(lvl) <= levels.indexOf(current);
  const log = (lvl, msg, meta) => {
    if (!should(lvl)) return;
    const payload = typeof msg === "string" ? { msg } : { ...msg };
    const line = JSON.stringify({ level: lvl, ts: Date.now(), ...payload, ...(meta || {}) });
    if (lvl === "error") console.error(line);
    else if (lvl === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    info: (msg, meta) => log("info", msg, meta),
    warn: (msg, meta) => log("warn", msg, meta),
    error: (msg, meta) => log("error", msg, meta),
    debug: (msg, meta) => log("debug", msg, meta)
  };
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(process.env.LOG_LEVEL || "info");

  const sessionStore = createSessionStore({ config, logger });
  const mcp = await createMcpClient({ config, logger });
  const llm = createLlmClient({ config, logger });
  const agent = createAgent({ config, logger, sessionStore, mcp, llm });

  const app = buildServer({ config, logger, agent });
  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info(`smart-house-agent listening on :${config.port}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

