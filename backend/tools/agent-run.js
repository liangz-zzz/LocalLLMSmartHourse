#!/usr/bin/env node
/**
 * Simple client for smart-house-agent.
 *
 * Examples:
 *   node backend/tools/agent-run.js --text "水在烧了么" --session demo
 *   node backend/tools/agent-run.js --text "关闭烧水壶" --session demo
 *   node backend/tools/agent-run.js --text "确认" --session demo --confirm
 */

const args = parseArgs(process.argv.slice(2));
const input = args.text || args._[0] || "";
if (!input.trim()) {
  console.error("Usage: node backend/tools/agent-run.js --text \"水在烧了么\" [--session demo] [--confirm]");
  process.exit(1);
}

const agentBase = (args.agent || process.env.AGENT_HTTP_BASE || "http://localhost:6000").replace(/\/$/, "");
const sessionId = String(args.session || args.sessionId || "demo").trim();
const confirm = Boolean(args.confirm);

async function main() {
  const res = await fetch(`${agentBase}/v1/agent/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, sessionId, confirm })
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [k, v] = a.replace(/^--/, "").split("=", 2);
    if (v !== undefined) {
      out[k] = v;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[k] = next;
      i++;
      continue;
    }
    out[k] = true;
  }
  return out;
}

