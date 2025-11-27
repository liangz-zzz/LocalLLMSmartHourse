import test from "node:test";
import assert from "node:assert/strict";
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
