import Fastify from "fastify";

export function buildServer({ store, logger, config, bus }) {
  const app = Fastify({ logger: false });

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
