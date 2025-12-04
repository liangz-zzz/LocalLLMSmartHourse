import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { buildApp } from "../src/index.js";

test("chat completions returns echo response", async () => {
  const app = buildApp();
  await app.listen({ port: 0 });
  const port = app.server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local-echo",
      messages: [{ role: "user", content: "hello" }]
    })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "Echo: hello");
  await app.close();
});

test("chat completions can forward to upstream", async () => {
  const upstream = Fastify({ logger: false });
  upstream.post("/v1/chat/completions", async (req, reply) => {
    return reply.send({
      id: "upstream",
      choices: [{ index: 0, message: { role: "assistant", content: "from upstream" }, finish_reason: "stop" }]
    });
  });
  await upstream.listen({ port: 0 });
  const upstreamPort = upstream.server.address().port;

  const app = buildApp({ forwardBase: `http://127.0.0.1:${upstreamPort}` });
  await app.listen({ port: 0 });
  const port = app.server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
  });
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "from upstream");

  await app.close();
  await upstream.close();
});

test("rate limiter returns 429 when exceeded", async () => {
  const app = buildApp({ forwardBase: "" });
  await app.listen({ port: 0 });
  const port = app.server.address().port;

  let lastStatus = 200;
  for (let i = 0; i < 70; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    });
    lastStatus = res.status;
    if (res.status === 429) break;
  }
  assert.equal(lastStatus, 429);
  await app.close();
});
