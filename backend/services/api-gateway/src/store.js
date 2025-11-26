import fs from "fs/promises";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";

export class MockStore {
  constructor(samplePath) {
    this.samplePath = samplePath;
    this.cache = [];
  }

  async init() {
    const raw = await fs.readFile(this.samplePath, "utf8");
    const device = JSON.parse(raw);
    this.cache = [device];
  }

  async list() {
    return this.cache;
  }

  async get(id) {
    return this.cache.find((d) => d.id === id);
  }
}

export class RedisStore {
  constructor({ redisUrl, prefix = "device", logger }) {
    this.redis = new Redis(redisUrl);
    this.logger = logger;
    this.prefix = prefix;
  }

  key(id) {
    return `${this.prefix}:${id}`;
  }

  async list() {
    const keys = await this.redis.keys(`${this.prefix}:*`);
    if (!keys.length) return [];
    const values = await this.redis.mget(keys);
    return values
      .map((v) => {
        try {
          return v ? JSON.parse(v) : null;
        } catch (_e) {
          this.logger?.warn("Invalid JSON in Redis", v?.slice(0, 50));
          return null;
        }
      })
      .filter(Boolean);
  }

  async get(id) {
    const raw = await this.redis.get(this.key(id));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch (_e) {
      this.logger?.warn("Invalid JSON in Redis for device", id);
      return undefined;
    }
  }

  async upsert(device) {
    await this.redis.set(this.key(device.id), JSON.stringify(device));
  }

  async clearTestPrefix() {
    const keys = await this.redis.keys(`${this.prefix}:*`);
    if (keys.length) {
      await this.redis.del(keys);
    }
  }

  async close() {
    await this.redis.quit();
  }

  async upsert(device) {
    await this.redis.set(this.key(device.id), JSON.stringify(device));
  }

  async clearTestPrefix() {
    const keys = await this.redis.keys(`${this.prefix}:*`);
    if (keys.length) {
      await this.redis.del(keys);
    }
  }

  async close() {
    await this.redis.quit();
  }
}

export class DbStore {
  constructor({ databaseUrl, logger }) {
    if (!process.env.DATABASE_URL && databaseUrl) {
      process.env.DATABASE_URL = databaseUrl;
    }
    this.logger = logger;
    this.prisma = new PrismaClient();
  }

  async list() {
    const rows = await this.prisma.device.findMany({
      include: { states: { orderBy: { createdAt: "desc" }, take: 1 } }
    });
    return rows.map(mapDbDevice);
  }

  async get(id) {
    const row = await this.prisma.device.findUnique({
      where: { id },
      include: { states: { orderBy: { createdAt: "desc" }, take: 1 } }
    });
    if (!row) return undefined;
    return mapDbDevice(row);
  }

  async close() {
    await this.prisma.$disconnect();
  }
}

function mapDbDevice(row) {
  const latestState = row.states?.[0]?.traits || {};
  const { states, ...rest } = row;
  return { ...rest, traits: latestState };
}
