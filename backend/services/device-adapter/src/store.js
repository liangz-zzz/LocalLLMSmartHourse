import Redis from "ioredis";

export class MemoryStore {
  constructor() {
    this.map = new Map();
  }

  async upsert(device) {
    this.map.set(device.id, device);
  }

  async list() {
    return Array.from(this.map.values());
  }

  async get(id) {
    return this.map.get(id);
  }
}

export class RedisStore {
  constructor({ url, prefix = "device", updatesChannel = "device:updates", actionResultsChannel = "device:action_results", logger }) {
    this.prefix = prefix;
    this.redis = new Redis(url);
    this.logger = logger;
    this.updatesChannel = updatesChannel;
    this.actionResultsChannel = actionResultsChannel;
  }

  key(id) {
    return `${this.prefix}:${id}`;
  }

  async upsert(device) {
    await this.redis.set(this.key(device.id), JSON.stringify(device));
    if (this.updatesChannel) {
      await this.redis.publish(this.updatesChannel, JSON.stringify(device));
    }
  }

  async publishActionResult(result) {
    if (!this.actionResultsChannel) return;
    await this.redis.publish(this.actionResultsChannel, JSON.stringify(result));
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
          this.logger?.warn?.("Invalid JSON in Redis", v?.slice(0, 50));
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
      this.logger?.warn?.("Invalid JSON in Redis for", id);
      return undefined;
    }
  }

  async clearTestPrefix() {
    // Used only in tests
    const keys = await this.redis.keys(`${this.prefix}:*`);
    if (keys.length) {
      await this.redis.del(keys);
    }
  }

  async close() {
    await this.redis.quit();
  }
}
