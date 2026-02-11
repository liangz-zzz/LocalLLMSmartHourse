import fs from "fs/promises";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { evaluateRules } from "./rules.js";
import { AutomationEngine } from "./automation-engine.js";
import { loadAutomationsFile, resolveAutomationsPath } from "./automations.js";
import { incCounter, snapshot, asPrometheus } from "./metrics.js";
import http from "http";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const redisPrefix = process.env.REDIS_PREFIX || "device";
const updatesChannel = process.env.REDIS_UPDATES_CHANNEL || "device:updates";
const actionsChannel = process.env.REDIS_ACTIONS_CHANNEL || "device:actions";
const rulesPath = process.env.RULES_PATH || new URL("../rules.json", import.meta.url).pathname;
const refreshMs = Number(process.env.RULES_REFRESH_MS || 10000);
const automationsRefreshMs = Number(process.env.AUTOMATIONS_REFRESH_MS || 3000);
const apiGatewayBase = process.env.API_GATEWAY_BASE || process.env.API_HTTP_BASE || "http://api-gateway:4000";
const apiGatewayApiKey = process.env.API_GATEWAY_API_KEY || process.env.API_KEY || "";
const configDir = process.env.CONFIG_DIR || "";
const automationsPath = resolveAutomationsPath({ automationsPath: process.env.AUTOMATIONS_PATH, configDir });

const logger = {
  info: (...args) => console.log("[info]", ...args),
  warn: (...args) => console.warn("[warn]", ...args),
  error: (...args) => console.error("[error]", ...args)
};

async function loadRulesFromFile() {
  try {
    const raw = await fs.readFile(rulesPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    logger.error("Failed to load rules file", err);
    return [];
  }
}

async function loadRulesFromDb(prisma) {
  try {
    const rows = await prisma.rule.findMany({ where: { enabled: true } });
    return rows.map((r) => ({ id: r.id, when: r.when, then: r.then }));
  } catch (err) {
    logger.error("Failed to load rules from DB", err);
    return [];
  }
}

async function logRuleAction(prisma, action, event) {
  if (!prisma) return;
  await prisma.actionResult.create({
    data: {
      id: `rule_${action.ruleId}_${Date.now()}`,
      deviceId: action.id,
      action: action.action,
      status: "queued_by_rule",
      transport: "rule",
      reason: `rule:${action.ruleId}`,
      params: action.params || {}
    }
  });
}

async function main() {
  const useDb = !!process.env.DATABASE_URL;
  const prisma = useDb ? new PrismaClient() : null;
  let rules = useDb ? await loadRulesFromDb(prisma) : await loadRulesFromFile();
  logger.info(`Loaded ${rules.length} rules from ${useDb ? "db" : "file"}`);

  if (useDb) {
    setInterval(async () => {
      rules = await loadRulesFromDb(prisma);
    }, refreshMs).unref();
  }

  const sub = new Redis(redisUrl);
  const pub = new Redis(redisUrl);
  await sub.subscribe(updatesChannel);

  const automationEngine = new AutomationEngine({
    logger,
    publishAction: async (action) => {
      await pub.publish(actionsChannel, JSON.stringify(action));
    },
    expandScene: async (sceneId) => await fetchExpandedScene(sceneId)
  });

  await seedDevicesFromRedis(pub, redisPrefix, automationEngine);

  let lastAutomationsMtimeMs = null;
  const refreshAutomations = async () => {
    const mtimeMs = await readMtimeMs(automationsPath);
    if (mtimeMs === lastAutomationsMtimeMs) return;
    lastAutomationsMtimeMs = mtimeMs;
    const loaded = await loadAutomationsFile(automationsPath);
    if (!loaded.ok) {
      logger.warn("Invalid automations file; keeping previous", { path: automationsPath, error: loaded.error, message: loaded.message, details: loaded.details });
      incCounter("automations_invalid");
      return;
    }
    automationEngine.setAutomations(loaded.items);
    logger.info(`Loaded ${loaded.items.length} automations from ${automationsPath}`);
    incCounter("automations_loaded", { count: loaded.items.length });
  };

  await refreshAutomations();
  if (Number.isFinite(automationsRefreshMs) && automationsRefreshMs > 0) {
    setInterval(() => {
      refreshAutomations().catch((err) => logger.warn("automations refresh failed", err?.message || String(err)));
    }, automationsRefreshMs).unref();
  }

  sub.on("message", (_channel, message) => {
    try {
      const event = JSON.parse(message);
      const matched = evaluateRules(event, rules, (action) => {
        if (useDb) {
          logRuleAction(prisma, action, event).catch((err) => logger.warn("rule log failed", err));
        }
        pub.publish(actionsChannel, JSON.stringify(action));
      });
      if (matched.length) {
        incCounter("rules_matched", { count: matched.length });
        logger.info("Rule matched", matched, "for", event.id);
      }
      automationEngine.handleDeviceUpdate(event);
    } catch (err) {
      logger.error("Failed to handle event", err);
    }
  });

  logger.info("Rules engine listening on", updatesChannel, "->", actionsChannel);

  // metrics endpoint
  const metricsPort = Number(process.env.METRICS_PORT || 9100);
  createMetricsServer(metricsPort);

  async function fetchExpandedScene(sceneId) {
    const url = `${stripTrailingSlash(apiGatewayBase)}/scenes/${encodeURIComponent(sceneId)}/expanded`;
    const res = await fetch(url, { headers: apiGatewayApiKey ? { "X-API-Key": apiGatewayApiKey } : {} });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`scene_expand_failed ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }
}

main().catch((err) => {
  logger.error("Rules engine failed", err);
  process.exit(1);
});

function createMetricsServer(port) {
  const server = http.createServer((_req, res) => {
    const url = new URL(_req.url || "/", "http://localhost");
    const format = url.searchParams.get("format");
    if (format === "prom") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(asPrometheus("rules_engine"));
      return;
    }
    const snap = snapshot();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snap));
  });
  server.listen(port, () => {
    logger.info("Metrics server listening on", port);
  });
}

async function seedDevicesFromRedis(redis, prefix, automationEngine) {
  try {
    const devices = await readDevicesSnapshot(redis, prefix);
    if (devices.length) {
      automationEngine.seedDevices(devices);
      logger.info(`Seeded ${devices.length} devices from redis (${prefix}:*)`);
    }
  } catch (err) {
    logger.warn("Failed to seed devices from redis", err?.message || String(err));
  }
}

async function readDevicesSnapshot(redis, prefix) {
  const pattern = `${prefix}:*`;
  let cursor = "0";
  const keys = [];
  do {
    const res = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = res[0];
    const batch = res[1] || [];
    keys.push(...batch);
  } while (cursor !== "0");

  if (!keys.length) return [];
  const values = await redis.mget(keys);
  const out = [];
  for (const raw of values) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
        out.push(parsed);
      }
    } catch (_e) {
      // ignore
    }
  }
  return out;
}

async function readMtimeMs(p) {
  try {
    const stat = await fs.stat(p);
    return stat.mtimeMs;
  } catch (err) {
    if (err?.code === "ENOENT") return 0;
    return 0;
  }
}

function stripTrailingSlash(s) {
  return String(s || "").replace(/\/$/, "");
}
