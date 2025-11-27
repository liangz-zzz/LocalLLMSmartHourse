import fs from "fs/promises";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { evaluateRules } from "./rules.js";

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
        pub.publish(actionsChannel, JSON.stringify(action));
      });
      if (matched.length) {
        logger.info("Rule matched", matched, "for", event.id);
      }
    } catch (err) {
      logger.error("Failed to handle event", err);
    }
  });

  logger.info("Rules engine listening on", updatesChannel, "->", actionsChannel);
}

main().catch((err) => {
  logger.error("Rules engine failed", err);
  process.exit(1);
});
