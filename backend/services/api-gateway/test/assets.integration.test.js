import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import { MockStore } from "../src/store.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assets-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAJk3nSAAAAAASUVORK5CYII=";

test("POST /assets uploads image assets", async () => {
  await withTempDir(async (dir) => {
    const samplePath = new URL("../src/fixtures/living_room_plug.json", import.meta.url);
    const store = new MockStore(samplePath);
    await store.init();
    const config = { mode: "mock", assetsDir: path.join(dir, "assets") };
    const app = buildServer({ store, logger: console, config });
    await app.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

    const buffer = Buffer.from(tinyPngBase64, "base64");
    const form = new FormData();
    form.set("kind", "floorplan_image");
    form.set("file", new Blob([buffer], { type: "image/png" }), "tiny.png");

    const res = await fetch(`${baseUrl}/assets`, { method: "POST", body: form });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.kind, "floorplan_image");
    assert.ok(payload.url.startsWith("/assets/floorplans/"));
    assert.equal(payload.width, 1);
    assert.equal(payload.height, 1);

    await app.close();
  });
});

test("POST /assets rejects mismatched asset kinds", async () => {
  await withTempDir(async (dir) => {
    const samplePath = new URL("../src/fixtures/living_room_plug.json", import.meta.url);
    const store = new MockStore(samplePath);
    await store.init();
    const config = { mode: "mock", assetsDir: path.join(dir, "assets") };
    const app = buildServer({ store, logger: console, config });
    await app.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

    const buffer = Buffer.from(tinyPngBase64, "base64");
    const form = new FormData();
    form.set("kind", "floorplan_model");
    form.set("file", new Blob([buffer], { type: "image/png" }), "tiny.png");

    const res = await fetch(`${baseUrl}/assets`, { method: "POST", body: form });
    assert.equal(res.status, 415);

    await app.close();
  });
});
