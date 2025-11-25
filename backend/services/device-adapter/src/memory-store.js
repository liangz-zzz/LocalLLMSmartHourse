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
