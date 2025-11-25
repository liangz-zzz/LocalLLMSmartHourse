import fs from "fs/promises";
import Redis from "ioredis";

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
  constructor(redisUrl, logger) {
    this.redis = new Redis(redisUrl);
    this.logger = logger;
  }

  async list() {
    const keys = await this.redis.keys("device:*");
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
    const raw = await this.redis.get(`device:${id}`);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch (_e) {
      this.logger?.warn("Invalid JSON in Redis for device", id);
      return undefined;
    }
  }
}
