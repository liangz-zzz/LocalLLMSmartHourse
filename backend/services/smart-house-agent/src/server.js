import Fastify from "fastify";

export function buildServer({ config, agent }) {
  const app = Fastify({ logger: false });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.post("/v1/agent/turn", async (req, reply) => {
    const body = req.body || {};
    const input = String(body.input || "").trim();
    if (!input) return reply.code(400).send({ error: "input_required" });

    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const confirm = Boolean(body.confirm);

    const out = await agent.turn({ sessionId, input, confirm });
    return reply.send(out);
  });

  app.setErrorHandler((err, _req, reply) => {
    reply.code(500).send({ error: "internal_error", message: err?.message || String(err) });
  });

  return app;
}

