import Fastify from "fastify";

export function buildApp(options = {}) {
  const forwardBase = options.forwardBase || process.env.UPSTREAM_API_BASE || "";
  const forwardApiKey = options.forwardApiKey || process.env.UPSTREAM_API_KEY || process.env.LLM_API_KEY || "";
  const forwardEnabled = Boolean(forwardBase);

  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/v1/chat/completions", async (req, reply) => {
    const { messages = [], model = "local-echo" } = req.body || {};

    if (forwardEnabled) {
      try {
        const target = `${forwardBase.replace(/\/$/, "")}/v1/chat/completions`;
        const upstream = await fetch(target, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: forwardApiKey ? `Bearer ${forwardApiKey}` : undefined
          },
          body: JSON.stringify({ ...req.body, model })
        });
        if (!upstream.ok) {
          const text = await upstream.text();
          app.log?.warn?.("Upstream LLM error", upstream.status, text);
        } else {
          const data = await upstream.json();
          return reply.send(data);
        }
      } catch (err) {
        app.log?.warn?.("Upstream LLM call failed, falling back to echo", err);
      }
    }

    const content = buildEcho(messages);
    const resp = {
      id: `chatcmpl_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: content.length,
        total_tokens: content.length
      }
    };
    return reply.send(resp);
  });

  app.setErrorHandler((err, _req, reply) => {
    reply.code(500).send({ error: "internal_error", message: err.message });
  });

  return app;
}

function buildEcho(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return lastUser?.content ? `Echo: ${lastUser.content}` : "Hello from llm-bridge stub.";
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT || 5000);
  const app = buildApp();
  app.listen({ port, host: "0.0.0.0" }).then(() => {
    console.log(`llm-bridge listening on :${port}`);
  });
}
