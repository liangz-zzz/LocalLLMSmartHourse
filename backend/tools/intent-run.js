#!/usr/bin/env node
/**
 * Simple intent -> action runner.
 *
 * Flow:
 * 1) GET devices from API Gateway
 * 2) POST /v1/intent to llm-bridge with { input, devices }
 * 3) (optional) POST /devices/:id/actions back to API Gateway
 *
 * This script defaults to dry-run (no device control). Use --execute to actually send actions.
 */

const args = parseArgs(process.argv.slice(2));
const input = args.text || args._[0] || "";
if (!input.trim()) {
  console.error("Usage: node backend/tools/intent-run.js --text \"打开烧水壶\" [--execute]");
  process.exit(1);
}

const gatewayBase = (args.gateway || process.env.API_HTTP_BASE || "http://localhost:4000").replace(/\/$/, "");
const llmBase = (args.llm || process.env.LLM_HTTP_BASE || process.env.LLM_API_BASE || "http://localhost:5000").replace(/\/$/, "");
const execute = Boolean(args.execute);

const gatewayApiKey = args.gatewayApiKey || process.env.API_KEY || process.env.API_KEYS || "";
const llmApiKey = args.llmApiKey || process.env.LLM_API_KEY || "";

const gatewayHeaders = {
  "Content-Type": "application/json",
  ...(gatewayApiKey ? { "X-API-Key": gatewayApiKey } : {})
};

const llmHeaders = {
  "Content-Type": "application/json",
  ...(llmApiKey ? { Authorization: `Bearer ${llmApiKey}` } : {})
};

async function main() {
  const devicesRes = await fetch(`${gatewayBase}/devices`, { headers: gatewayHeaders });
  if (!devicesRes.ok) {
    throw new Error(`Failed to list devices: ${devicesRes.status} ${(await devicesRes.text()).slice(0, 200)}`);
  }
  const devicesBody = await devicesRes.json();
  const devices = devicesBody.items || [];

  const intentRes = await fetch(`${llmBase}/v1/intent`, {
    method: "POST",
    headers: llmHeaders,
    body: JSON.stringify({ input, devices })
  });
  if (!intentRes.ok) {
    throw new Error(`Failed to parse intent: ${intentRes.status} ${(await intentRes.text()).slice(0, 200)}`);
  }
  const intentBody = await intentRes.json();
  const intent = intentBody.intent || {};

  console.log(JSON.stringify({ input, intent }, null, 2));

  if (!execute) {
    console.log("\n(dry-run) Use --execute to send the action to the device.");
    return;
  }
  if (!intent.deviceId || !intent.action) {
    throw new Error("Intent missing deviceId/action; aborting execute.");
  }

  const actionRes = await fetch(`${gatewayBase}/devices/${encodeURIComponent(intent.deviceId)}/actions`, {
    method: "POST",
    headers: gatewayHeaders,
    body: JSON.stringify({ action: intent.action, params: intent.params || {} })
  });
  const actionBody = await actionRes.json().catch(() => ({}));
  if (!actionRes.ok) {
    throw new Error(`Failed to enqueue action: ${actionRes.status} ${JSON.stringify(actionBody)}`);
  }
  console.log("\nEnqueued:", JSON.stringify(actionBody, null, 2));
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

