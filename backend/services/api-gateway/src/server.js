import Fastify from "fastify";

export function buildServer({ store, logger, config, bus }) {
  const app = Fastify({ logger: false });

  const validateActionParams = (device, action, params) => {
    const capability = device.capabilities?.find((c) => c.action === action);
    if (!capability || !capability.parameters) return { ok: true };
    for (const p of capability.parameters) {
      const value = params?.[p.name];
      if (value === undefined) continue; // optional unless enum with required? keep loose for now
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

  app.setErrorHandler((err, _req, reply) => {
    logger?.error("Server error", err);
    reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
