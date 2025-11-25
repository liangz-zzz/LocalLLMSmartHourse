#!/usr/bin/env node
/**
 * Quick Home Assistant connectivity check.
 * Reads HA_ELEVATED_TOKEN and HA_BASE_URL (default http://localhost:8123) from env.
 *
 * Examples:
 *   node backend/tools/ha-check.js --entity switch.living_room_plug
 *   node backend/tools/ha-check.js --full     # print all states (can be verbose)
 */
const args = process.argv.slice(2);

const entityIdx = args.indexOf("--entity");
const targetEntity = entityIdx !== -1 ? args[entityIdx + 1] : undefined;
const full = args.includes("--full");

const baseUrl = process.env.HA_BASE_URL || "http://localhost:8123";
const token = process.env.HA_ELEVATED_TOKEN;

if (!token) {
  console.error("HA_ELEVATED_TOKEN is required. Set it in your environment or .env.");
  process.exit(1);
}

const normalizedBase = baseUrl.replace(/\/$/, "");
const url = targetEntity ? `${normalizedBase}/api/states/${targetEntity}` : `${normalizedBase}/api/states`;

async function main() {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    console.error(`Request failed: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.error(text);
    process.exit(1);
  }

  const data = await res.json();

  if (targetEntity) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (full) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Summary view: show total count and first 5 entities
  const items = Array.isArray(data) ? data : [];
  console.log(`Fetched ${items.length} states from ${baseUrl}`);
  items.slice(0, 5).forEach((item) => {
    console.log(`- ${item.entity_id}: ${JSON.stringify(item.state)}`);
  });
  if (items.length > 5) {
    console.log(`...and ${items.length - 5} more. Use --full to print all.`);
  }
}

main().catch((err) => {
  console.error("Error talking to Home Assistant:", err);
  process.exit(1);
});
