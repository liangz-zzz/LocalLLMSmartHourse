import Fastify from "fastify";

export function buildServer({ store, logger, config, bus, actionStore, ruleStore }) {
  const app = Fastify({ logger: false });

  const validateActionParams = (device, action, params) => {
    const capability = device.capabilities?.find((c) => c.action === action);
    if (!capability || !capability.parameters) return { ok: true };
    for (const p of capability.parameters) {
      const value = params?.[p.name];
      if (value === undefined) {
        if (p.required) return { ok: false, reason: `param ${p.name} is required` };
        continue; // optional
      }
      if (p.type === "boolean" && typeof value !== "boolean") return { ok: false, reason: `param ${p.name} must be boolean` };
      if (p.type === "number") {
        if (typeof value !== "number") return { ok: false, reason: `param ${p.name} must be number` };
        if (p.minimum !== undefined && value < p.minimum) return { ok: false, reason: `param ${p.name} min ${p.minimum}` };
        if (p.maximum !== undefined && value > p.maximum) return { ok: false, reason: `param ${p.name} max ${p.maximum}` };
      }
      if (p.type === "enum") {
        if (!Array.isArray(p.enum) || !p.enum.includes(value)) return { ok: false, reason: `param ${p.name} must be in enum` };
      }
      if (p.type === "string" && typeof value !== "string") return { ok: false, reason: `param ${p.name} must be string` };
    }
    return { ok: true };
  };

  const validateRulePayload = (payload) => {
    if (!payload || !payload.when || !payload.then) return { ok: false, reason: "rule when/then required" };
    if (payload.when.deviceId && typeof payload.when.deviceId !== "string") return { ok: false, reason: "deviceId must be string" };
    if (payload.when.traitPath && typeof payload.when.traitPath !== "string") return { ok: false, reason: "traitPath must be string" };
    if (payload.when.equals === undefined) return { ok: false, reason: "when.equals required" };
    if (!payload.then.action) return { ok: false, reason: "then.action required" };
    return { ok: true };
  };

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/devices", async () => {
    const list = await store.list();
    return { items: list, count: list.length };
  });

  app.get("/devices/:id", async (req, reply) => {
    const device = await store.get(req.params.id);
    if (!device) {
      return reply.code(404).send({ error: "not_found" });
    }
    return device;
  });

  app.get("/devices/:id/actions", async (req, reply) => {
    if (!actionStore) return reply.code(503).send({ error: "action_store_unavailable" });
    const device = await store.get(req.params.id);
    if (!device) {
      return reply.code(404).send({ error: "not_found" });
    }
    const limit = Math.min(Number(req.query?.limit || 20), 100);
    const offset = Math.max(Number(req.query?.offset || 0), 0);
    const items = await actionStore.listByDevice(req.params.id, limit, offset);
    return { items, limit, offset };
  });

  app.post("/devices/:id/actions", async (req, reply) => {
    const { action, params } = req.body || {};
    if (!action) {
      return reply.code(400).send({ error: "action_required" });
    }

    const device = await store.get(req.params.id);
    if (!device) {
      return reply.code(404).send({ error: "device_not_found" });
    }

    const allowed = device.capabilities?.some((c) => c.action === action);
    if (!allowed) {
      return reply.code(400).send({ error: "action_not_supported" });
    }

    const validation = validateActionParams(device, action, params);
    if (!validation.ok) {
      return reply.code(400).send({ error: "invalid_params", reason: validation.reason });
    }

    if (!bus) {
      return reply.code(503).send({ error: "bus_unavailable" });
    }
    await bus.publishAction({
      id: req.params.id,
      action,
      params: params || {},
      ts: Date.now()
    });
    return { status: "queued" };
  });

  // Rule management (requires DB)
  app.get("/rules", async (_req, reply) => {
    if (!ruleStore) return reply.code(503).send({ error: "rule_store_unavailable" });
    const items = await ruleStore.list();
    return { items };
  });

  app.post("/rules", async (req, reply) => {
    if (!ruleStore) return reply.code(503).send({ error: "rule_store_unavailable" });
    const { id, name, when, then, enabled } = req.body || {};
    const validation = validateRulePayload({ id, when, then });
    if (!id || !validation.ok) {
      return reply.code(400).send({ error: "invalid_rule", reason: validation.reason || "id required" });
    }
    const created = await ruleStore.create({ id, name, when, then, enabled });
    return created;
  });

  app.get("/rules/:id", async (req, reply) => {
    if (!ruleStore) return reply.code(503).send({ error: "rule_store_unavailable" });
    const rule = await ruleStore.get(req.params.id);
    if (!rule) return reply.code(404).send({ error: "not_found" });
    return rule;
  });

  app.put("/rules/:id", async (req, reply) => {
    if (!ruleStore) return reply.code(503).send({ error: "rule_store_unavailable" });
    const { name, when, then, enabled } = req.body || {};
    const validation = validateRulePayload({ id: req.params.id, when, then });
    if (!validation.ok) {
      return reply.code(400).send({ error: "invalid_rule", reason: validation.reason });
    }
    const updated = await ruleStore.update(req.params.id, { name, when, then, enabled });
    return updated;
  });

  app.delete("/rules/:id", async (req, reply) => {
    if (!ruleStore) return reply.code(503).send({ error: "rule_store_unavailable" });
    await ruleStore.delete(req.params.id);
    return { status: "deleted" };
  });

  app.setErrorHandler((err, _req, reply) => {
    logger?.error("Server error", err);
    reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
