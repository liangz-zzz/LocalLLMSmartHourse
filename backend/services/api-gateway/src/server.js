import Fastify from "fastify";
import websocket from "@fastify/websocket";

export function buildServer({ store, logger, config }) {
  const app = Fastify({ logger: false });
  app.register(websocket);

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

  app.get("/ws", { websocket: true }, (conn) => {
    conn.socket.send(JSON.stringify({ type: "hello", mode: config.mode }));
    // Placeholder: future event streaming via Redis Pub/Sub or MQTT bridge
  });

  app.setErrorHandler((err, _req, reply) => {
    logger?.error("Server error", err);
    reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
