import Fastify from "fastify";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import imageSize from "image-size";
import { SceneStoreError } from "./scene-store.js";
import { FloorplanStoreError } from "./floorplan-store.js";

export function buildServer({ store, logger, config, bus, actionStore, ruleStore, sceneStore, floorplanStore }) {
  const app = Fastify({ logger: false });
  const apiKeys = config.apiKeys || [];
  let assetsDir = String(config.assetsDir || path.resolve(process.cwd(), "assets"));
  if (!path.isAbsolute(assetsDir)) {
    assetsDir = path.resolve(process.cwd(), assetsDir);
  }
  const assetMaxImageBytes = Math.max(1, Number(config.assetMaxImageMb || 20)) * 1024 * 1024;
  const assetMaxModelBytes = Math.max(1, Number(config.assetMaxModelMb || 200)) * 1024 * 1024;

  try {
    fs.mkdirSync(assetsDir, { recursive: true });
  } catch (err) {
    logger?.warn?.("Failed to ensure assets dir", err?.message || err);
  }
  if (config.jwtSecret) {
    app.register(jwt, {
      secret: config.jwtSecret,
      verify: {
        aud: config.jwtAudience || undefined,
        iss: config.jwtIssuer || undefined
      }
    });
  }

  app.register(multipart, {
    limits: {
      fileSize: Math.max(assetMaxImageBytes, assetMaxModelBytes)
    }
  });

  app.register(fastifyStatic, {
    root: assetsDir,
    prefix: "/assets/"
  });

  const authGuard = async (req, reply) => {
    // If neither API keys nor JWT are configured, allow anonymous access (dev/default).
    if (!apiKeys.length && !config.jwtSecret) return;

    const headerKey = req.headers["x-api-key"] || req.headers["authorization"]?.replace(/Bearer\s+/i, "");
    const qsKey = req.query?.api_key;
    const apiKeyOk = apiKeys.length && (apiKeys.includes(String(headerKey)) || apiKeys.includes(String(qsKey)));
    if (apiKeyOk) return;

    if (config.jwtSecret) {
      try {
        await req.jwtVerify();
        return;
      } catch (err) {
        logger?.warn("JWT verify failed", err.message);
      }
    }
    return reply.code(401).send({ error: "unauthorized" });
  };

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

  app.post("/assets", { preHandler: authGuard }, async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: "asset_invalid", reason: "multipart_required" });
    }

    let filePart = null;
    let kind = "";
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (!filePart) {
          filePart = part;
        } else {
          await drainStream(part.file);
        }
      } else if (part.type === "field" && part.fieldname === "kind") {
        kind = String(part.value || "");
      }
    }

    if (!filePart) {
      return reply.code(400).send({ error: "asset_invalid", reason: "file_required" });
    }
    const normalizedKind = String(kind || "").trim();
    if (!normalizedKind) {
      await drainStream(filePart.file);
      return reply.code(400).send({ error: "asset_invalid", reason: "kind_required" });
    }

    try {
      const payload = await storeAsset({
        file: filePart.file,
        filename: filePart.filename,
        mimetype: filePart.mimetype,
        kind: normalizedKind,
        assetsDir,
        maxImageBytes: assetMaxImageBytes,
        maxModelBytes: assetMaxModelBytes
      });
      return payload;
    } catch (err) {
      if (err?.code === "asset_invalid") {
        return reply.code(400).send({ error: "asset_invalid", reason: err.message });
      }
      if (err?.code === "payload_too_large") {
        return reply.code(413).send({ error: "payload_too_large", reason: err.message });
      }
      if (err?.code === "unsupported_media_type") {
        return reply.code(415).send({ error: "unsupported_media_type", reason: err.message });
      }
      throw err;
    }
  });

  app.get("/devices", { preHandler: authGuard }, async () => {
    const list = await store.list();
    return { items: list, count: list.length };
  });

  app.get("/devices/:id", { preHandler: authGuard }, async (req, reply) => {
    const device = await store.get(req.params.id);
    if (!device) {
      return reply.code(404).send({ error: "not_found" });
    }
    return device;
  });

  app.get("/devices/:id/actions", { preHandler: authGuard }, async (req, reply) => {
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

  app.post("/devices/:id/actions", { preHandler: authGuard }, async (req, reply) => {
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
      ts: Date.now(),
      actor: getActor(req)
    });
    logger?.info("action.enqueued", { id: req.params.id, action, actor: getActor(req) });
    return { status: "queued" };
  });

  // Scene management (file-backed)
  app.get("/scenes", { preHandler: authGuard }, async (_req, reply) => {
    if (!sceneStore) return reply.code(503).send({ error: "scene_store_unavailable" });
    try {
      const list = await sceneStore.list();
      const items = list.map((scene) => ({ id: scene.id, name: scene.name, description: scene.description }));
      return { items, count: items.length };
    } catch (err) {
      return handleSceneError(err, reply, logger);
    }
  });

  app.get("/scenes/:id", { preHandler: authGuard }, async (req, reply) => {
    if (!sceneStore) return reply.code(503).send({ error: "scene_store_unavailable" });
    try {
      const scene = await sceneStore.get(req.params.id);
      if (!scene) return reply.code(404).send({ error: "scene_not_found" });
      return scene;
    } catch (err) {
      return handleSceneError(err, reply, logger);
    }
  });

  app.get("/scenes/:id/expanded", { preHandler: authGuard }, async (req, reply) => {
    if (!sceneStore) return reply.code(503).send({ error: "scene_store_unavailable" });
    try {
      const steps = await sceneStore.expand(req.params.id);
      return { id: req.params.id, steps, count: steps.length };
    } catch (err) {
      return handleSceneError(err, reply, logger);
    }
  });

  app.post("/scenes", { preHandler: authGuard }, async (req, reply) => {
    if (!sceneStore) return reply.code(503).send({ error: "scene_store_unavailable" });
    try {
      const created = await sceneStore.create(req.body || {});
      logger?.info("scene.created", { id: created?.id, actor: getActor(req) });
      return created;
    } catch (err) {
      return handleSceneError(err, reply, logger);
    }
  });

  app.put("/scenes/:id", { preHandler: authGuard }, async (req, reply) => {
    if (!sceneStore) return reply.code(503).send({ error: "scene_store_unavailable" });
    const payload = req.body || {};
    if (payload?.id && payload.id !== req.params.id) {
      return reply.code(400).send({ error: "scene_id_mismatch" });
    }
    try {
      const updated = await sceneStore.update(req.params.id, payload);
      logger?.info("scene.updated", { id: req.params.id, actor: getActor(req) });
      return updated;
    } catch (err) {
      return handleSceneError(err, reply, logger);
    }
  });

  app.delete("/scenes/:id", { preHandler: authGuard }, async (req, reply) => {
    if (!sceneStore) return reply.code(503).send({ error: "scene_store_unavailable" });
    const cascade = req.query?.cascade === "true" || req.query?.cascade === "1";
    try {
      const result = await sceneStore.delete(req.params.id, { cascade });
      logger?.info("scene.deleted", { id: req.params.id, cascade, actor: getActor(req) });
      return { status: "deleted", removed: result.removed };
    } catch (err) {
      return handleSceneError(err, reply, logger);
    }
  });

  // Floorplan management (file-backed)
  app.get("/floorplans", { preHandler: authGuard }, async (_req, reply) => {
    if (!floorplanStore) return reply.code(503).send({ error: "floorplan_store_unavailable" });
    try {
      const list = await floorplanStore.list();
      const items = list.map((plan) => ({
        id: plan.id,
        name: plan.name,
        image: plan.image,
        model: plan.model,
        roomCount: Array.isArray(plan.rooms) ? plan.rooms.length : 0,
        deviceCount: Array.isArray(plan.devices) ? plan.devices.length : 0
      }));
      return { items, count: items.length };
    } catch (err) {
      return handleFloorplanError(err, reply, logger);
    }
  });

  app.get("/floorplans/:id", { preHandler: authGuard }, async (req, reply) => {
    if (!floorplanStore) return reply.code(503).send({ error: "floorplan_store_unavailable" });
    try {
      const plan = await floorplanStore.get(req.params.id);
      if (!plan) return reply.code(404).send({ error: "floorplan_not_found" });
      return plan;
    } catch (err) {
      return handleFloorplanError(err, reply, logger);
    }
  });

  app.post("/floorplans", { preHandler: authGuard }, async (req, reply) => {
    if (!floorplanStore) return reply.code(503).send({ error: "floorplan_store_unavailable" });
    try {
      const created = await floorplanStore.create(req.body || {});
      logger?.info("floorplan.created", { id: created?.id, actor: getActor(req) });
      return created;
    } catch (err) {
      return handleFloorplanError(err, reply, logger);
    }
  });

  app.put("/floorplans/:id", { preHandler: authGuard }, async (req, reply) => {
    if (!floorplanStore) return reply.code(503).send({ error: "floorplan_store_unavailable" });
    const payload = req.body || {};
    if (payload?.id && payload.id !== req.params.id) {
      return reply.code(400).send({ error: "floorplan_id_mismatch" });
    }
    try {
      const updated = await floorplanStore.update(req.params.id, payload);
      logger?.info("floorplan.updated", { id: req.params.id, actor: getActor(req) });
      return updated;
    } catch (err) {
      return handleFloorplanError(err, reply, logger);
    }
  });

  app.delete("/floorplans/:id", { preHandler: authGuard }, async (req, reply) => {
    if (!floorplanStore) return reply.code(503).send({ error: "floorplan_store_unavailable" });
    try {
      const result = await floorplanStore.delete(req.params.id);
      logger?.info("floorplan.deleted", { id: req.params.id, actor: getActor(req) });
      return { status: "deleted", removed: result.removed };
    } catch (err) {
      return handleFloorplanError(err, reply, logger);
    }
  });

  // Rule management (requires DB)
  app.get("/rules", { preHandler: authGuard }, async (_req, reply) => {
    if (!ruleStore) return reply.code(503).send({ error: "rule_store_unavailable" });
    const items = await ruleStore.list();
    return { items };
  });

  app.post("/rules", { preHandler: authGuard }, async (req, reply) => {
    if (!ruleStore) return reply.code(503).send({ error: "rule_store_unavailable" });
    const { id, name, when, then, enabled } = req.body || {};
    const validation = validateRulePayload({ id, when, then });
    if (!id || !validation.ok) {
      return reply.code(400).send({ error: "invalid_rule", reason: validation.reason || "id required" });
    }
    const created = await ruleStore.create({ id, name, when, then, enabled });
    logger?.info("rule.created", { id, actor: getActor(req) });
    return created;
  });

  app.get("/rules/:id", { preHandler: authGuard }, async (req, reply) => {
    if (!ruleStore) return reply.code(503).send({ error: "rule_store_unavailable" });
    const rule = await ruleStore.get(req.params.id);
    if (!rule) return reply.code(404).send({ error: "not_found" });
    return rule;
  });

  app.put("/rules/:id", { preHandler: authGuard }, async (req, reply) => {
    if (!ruleStore) return reply.code(503).send({ error: "rule_store_unavailable" });
    const { name, when, then, enabled } = req.body || {};
    const validation = validateRulePayload({ id: req.params.id, when, then });
    if (!validation.ok) {
      return reply.code(400).send({ error: "invalid_rule", reason: validation.reason });
    }
    const updated = await ruleStore.update(req.params.id, { name, when, then, enabled });
    logger?.info("rule.updated", { id: req.params.id, actor: getActor(req) });
    return updated;
  });

  app.delete("/rules/:id", { preHandler: authGuard }, async (req, reply) => {
    if (!ruleStore) return reply.code(503).send({ error: "rule_store_unavailable" });
    await ruleStore.delete(req.params.id);
    logger?.info("rule.deleted", { id: req.params.id, actor: getActor(req) });
    return { status: "deleted" };
  });

  app.setErrorHandler((err, _req, reply) => {
    logger?.error("Server error", err);
    reply.code(500).send({ error: "internal_error" });
  });

  return app;
}

function getActor(req) {
  const headerKey = req?.headers?.["x-api-key"];
  const bearer = req?.headers?.authorization;
  const qsKey = req?.query?.api_key;
  const jwtSub = req?.user?.sub;
  return jwtSub || bearer || headerKey || qsKey || "anonymous";
}

function handleSceneError(err, reply, logger) {
  if (err instanceof SceneStoreError) {
    if (err.code === "scene_not_found") {
      return reply.code(404).send({ error: "scene_not_found" });
    }
    if (err.code === "scene_exists") {
      return reply.code(409).send({ error: "scene_exists" });
    }
    if (err.code === "scene_has_dependents") {
      return reply.code(409).send({ error: "scene_has_dependents", dependents: err.dependents || [] });
    }
    if (err.code === "invalid_scene") {
      return reply.code(400).send({ error: "invalid_scene", reason: err.message, details: err.details || [] });
    }
    logger?.warn?.("Scene store error", { error: err.code, message: err.message });
    return reply.code(500).send({ error: "scene_store_error", message: err.message });
  }
  throw err;
}

function handleFloorplanError(err, reply, logger) {
  if (err instanceof FloorplanStoreError) {
    if (err.code === "floorplan_not_found") {
      return reply.code(404).send({ error: "floorplan_not_found" });
    }
    if (err.code === "floorplan_exists") {
      return reply.code(409).send({ error: "floorplan_exists" });
    }
    if (err.code === "invalid_floorplan") {
      return reply.code(400).send({ error: "invalid_floorplan", reason: err.message, details: err.details || [] });
    }
    logger?.warn?.("Floorplan store error", { error: err.code, message: err.message });
    return reply.code(500).send({ error: "floorplan_store_error", message: err.message });
  }
  throw err;
}

async function storeAsset({ file, filename, mimetype, kind, assetsDir, maxImageBytes, maxModelBytes }) {
  const normalizedKind = String(kind || "").trim();
  if (!["floorplan_image", "floorplan_model"].includes(normalizedKind)) {
    await drainStream(file);
    const err = new Error("kind must be floorplan_image or floorplan_model");
    err.code = "asset_invalid";
    throw err;
  }

  const isImage = normalizedKind === "floorplan_image";
  const allowedImage = {
    "image/png": ".png",
    "image/jpeg": ".jpg"
  };
  const allowedModel = new Set(["model/gltf-binary", "application/octet-stream"]);
  let ext = "";
  if (isImage) {
    ext = allowedImage[mimetype];
    if (!ext) {
      await drainStream(file);
      const err = new Error(`unsupported image mimetype ${mimetype || "unknown"}`);
      err.code = "unsupported_media_type";
      throw err;
    }
  } else {
    if (!allowedModel.has(mimetype)) {
      const nameExt = path.extname(String(filename || "")).toLowerCase();
      if (nameExt !== ".glb") {
        await drainStream(file);
        const err = new Error(`unsupported model mimetype ${mimetype || "unknown"}`);
        err.code = "unsupported_media_type";
        throw err;
      }
    }
    ext = ".glb";
  }

  const maxBytes = isImage ? maxImageBytes : maxModelBytes;
  const assetId = `asset_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const targetDir = path.join(assetsDir, "floorplans");
  await fsPromises.mkdir(targetDir, { recursive: true });
  const finalPath = path.join(targetDir, `${assetId}${ext}`);
  const tmpPath = `${finalPath}.tmp-${Date.now()}`;

  let size = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error("payload exceeds limit");
        err.code = "payload_too_large";
        callback(err);
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(file, limiter, fs.createWriteStream(tmpPath));
  } catch (err) {
    await fsPromises.rm(tmpPath, { force: true });
    if (err?.code === "payload_too_large") {
      err.message = `payload exceeds ${maxBytes} bytes`;
      throw err;
    }
    throw err;
  }

  await fsPromises.rename(tmpPath, finalPath);

  let width;
  let height;
  if (isImage) {
    try {
      const buffer = await fsPromises.readFile(finalPath);
      const sizeInfo = imageSize(buffer);
      width = sizeInfo.width;
      height = sizeInfo.height;
    } catch (err) {
      await fsPromises.rm(finalPath, { force: true });
      const error = new Error(`failed to read image size: ${err.message}`);
      error.code = "asset_invalid";
      throw error;
    }
  }

  return {
    assetId,
    url: `/assets/floorplans/${assetId}${ext}`,
    kind: normalizedKind,
    mime: mimetype,
    size,
    ...(Number.isFinite(width) ? { width } : {}),
    ...(Number.isFinite(height) ? { height } : {})
  };
}

function drainStream(stream) {
  if (!stream || typeof stream.resume !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    stream.on("error", resolve);
    stream.on("end", resolve);
    stream.resume();
  });
}
