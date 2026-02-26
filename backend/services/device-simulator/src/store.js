import Redis from "ioredis";

export class MemoryStore {
  constructor() {
    this.map = new Map();
    this.actionResults = [];
    this.stateSnapshots = [];
  }

  async upsert(device) {
    this.map.set(device.id, clone(device));
  }

  async list() {
    return Array.from(this.map.values()).map(clone);
  }

  async get(id) {
    const item = this.map.get(id);
    return item ? clone(item) : undefined;
  }

  async publishActionResult(result) {
    this.actionResults.push(clone(result));
  }

  async publishStateSnapshot(device) {
    this.stateSnapshots.push({ id: device.id, traits: clone(device.traits || {}), ts: Date.now() });
  }

  async close() {}
}

export class RedisStore {
  constructor({ url, prefix = "device", updatesChannel = "device:updates", actionResultsChannel = "device:action_results", logger }) {
    this.prefix = prefix;
    this.redis = new Redis(url);
    this.logger = logger;
    this.updatesChannel = updatesChannel;
    this.actionResultsChannel = actionResultsChannel;
    this.stateResultsChannel = `${actionResultsChannel}:state`;
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

  async list() {
    const keys = await this.redis.keys(`${this.prefix}:*`);
    if (!keys.length) return [];
    const values = await this.redis.mget(keys);
    return values
      .map((value) => {
        try {
          return value ? JSON.parse(value) : null;
        } catch (_e) {
          this.logger?.warn?.("Invalid JSON in Redis", value?.slice(0, 50));
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

  async publishActionResult(result) {
    if (!this.actionResultsChannel) return;
    await this.redis.publish(this.actionResultsChannel, JSON.stringify(result));
  }

  async publishStateSnapshot(device) {
    if (!this.stateResultsChannel) return;
    await this.redis.publish(
      this.stateResultsChannel,
      JSON.stringify({
        id: device.id,
        traits: device.traits,
        ts: Date.now()
      })
    );
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

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
