import { randomUUID } from "node:crypto";

import Redis from "ioredis";

export function createSessionStore({ config, logger }) {
  const ttlMs = config.sessionTtlMs;
  const maxMessages = config.maxMessages;

  if (config.redisUrl) {
    const redis = new Redis(config.redisUrl);
    redis.on("error", (err) => logger?.warn?.({ msg: "Redis error", error: err?.message || String(err) }));

    const key = (id) => `sha:session:${id}`;

    return {
      async getOrCreate(id) {
        const sessionId = id || randomUUID();
        const raw = await redis.get(key(sessionId));
        if (raw) {
          try {
            const data = JSON.parse(raw);
            return normalizeSession({ data, sessionId, maxMessages });
          } catch {
            // fallthrough to recreate
          }
        }
        const data = newSession(sessionId);
        await redis.set(key(sessionId), JSON.stringify(data), "PX", ttlMs);
        return data;
      },
      async save(session) {
        const data = normalizeSession({ data: session, sessionId: session.id, maxMessages });
        await redis.set(key(session.id), JSON.stringify(data), "PX", ttlMs);
      }
    };
  }

  const mem = new Map(); // id -> {data, expiresAt}

  function now() {
    return Date.now();
  }

  function prune() {
    const t = now();
    for (const [id, v] of mem.entries()) {
      if (v.expiresAt <= t) mem.delete(id);
    }
  }

  return {
    async getOrCreate(id) {
      prune();
      const sessionId = id || randomUUID();
      const existing = mem.get(sessionId);
      if (existing) return normalizeSession({ data: existing.data, sessionId, maxMessages });
      const data = newSession(sessionId);
      mem.set(sessionId, { data, expiresAt: now() + ttlMs });
      return data;
    },
    async save(session) {
      prune();
      const data = normalizeSession({ data: session, sessionId: session.id, maxMessages });
      mem.set(session.id, { data, expiresAt: now() + ttlMs });
    }
  };
}

function newSession(id) {
  return {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    state: {
      lastDeviceId: null,
      lastDeviceName: null,
      lastRoom: null,
      lastExecution: null,
      pending: null
    }
  };
}

function normalizeSession({ data, sessionId, maxMessages }) {
  const session = data && typeof data === "object" ? data : newSession(sessionId);
  session.id = sessionId;
  session.createdAt = Number(session.createdAt) || Date.now();
  session.updatedAt = Date.now();
  if (!Array.isArray(session.messages)) session.messages = [];
  session.messages = session.messages.slice(-maxMessages);
  if (!session.state || typeof session.state !== "object") {
    session.state = { lastDeviceId: null, lastDeviceName: null, lastRoom: null, lastExecution: null, pending: null };
  } else {
    if (session.state.lastDeviceId === undefined) session.state.lastDeviceId = null;
    if (session.state.lastDeviceName === undefined) session.state.lastDeviceName = null;
    if (session.state.lastRoom === undefined) session.state.lastRoom = null;
    if (session.state.lastExecution === undefined) session.state.lastExecution = null;
    if (session.state.pending === undefined) session.state.pending = null;
  }
  return session;
}
