import fs from "fs/promises";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { evaluateRules } from "./rules.js";
import { incCounter, snapshot, asPrometheus } from "./metrics.js";
import http from "http";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const updatesChannel = process.env.REDIS_UPDATES_CHANNEL || "device:updates";
const actionsChannel = process.env.REDIS_ACTIONS_CHANNEL || "device:actions";
const rulesPath = process.env.RULES_PATH || new URL("../rules.json", import.meta.url).pathname;
const refreshMs = Number(process.env.RULES_REFRESH_MS || 10000);

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
    } catch (err) {
      logger.error("Failed to handle event", err);
    }
  });

  logger.info("Rules engine listening on", updatesChannel, "->", actionsChannel);

  // metrics endpoint
  const metricsPort = Number(process.env.METRICS_PORT || 9100);
  createMetricsServer(metricsPort);
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
