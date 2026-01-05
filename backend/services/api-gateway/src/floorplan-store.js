import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_VERSION = 1;

export class FloorplanStoreError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    if (extra && typeof extra === "object") {
      Object.assign(this, extra);
    }
  }
}

export class FloorplanStore {
  constructor({ floorplansPath, logger }) {
    this.floorplansPath = floorplansPath || "./floorplans.json";
    this.logger = logger;
  }

  resolvePath() {
    const raw = String(this.floorplansPath || "").trim() || "./floorplans.json";
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }

  async list() {
    const { floorplans } = await this.load();
    validateFloorplanList(floorplans);
    return floorplans;
  }

  async get(id) {
    const list = await this.list();
    return list.find((plan) => plan.id === id);
  }

  async create(plan) {
    const data = await this.load();
    const list = data.floorplans;
    const id = String(plan?.id || "").trim();
    if (!id) {
      throw new FloorplanStoreError("invalid_floorplan", "floorplan id is required");
    }
    if (list.some((item) => item?.id === id)) {
      throw new FloorplanStoreError("floorplan_exists", `floorplan ${id} already exists`);
    }
    const next = list.concat([plan]);
    validateFloorplanList(next);
    await this.save({ version: data.version, floorplans: next });
    return plan;
  }

  async update(id, plan) {
    const data = await this.load();
    const list = data.floorplans;
    const index = list.findIndex((item) => item?.id === id);
    if (index < 0) {
      throw new FloorplanStoreError("floorplan_not_found", `floorplan ${id} not found`);
    }
    const next = [...list];
    next[index] = { ...plan, id };
    validateFloorplanList(next);
    await this.save({ version: data.version, floorplans: next });
    return next[index];
  }

  async delete(id) {
    const data = await this.load();
    const list = data.floorplans;
    const index = list.findIndex((item) => item?.id === id);
    if (index < 0) {
      throw new FloorplanStoreError("floorplan_not_found", `floorplan ${id} not found`);
    }
    const next = list.filter((item) => item?.id !== id);
    await this.save({ version: data.version, floorplans: next });
    return { removed: id };
  }

  async load() {
    const resolved = this.resolvePath();
    try {
      const raw = await fs.readFile(resolved, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeFloorplans(parsed);
    } catch (err) {
      if (err?.code === "ENOENT") {
        return { version: DEFAULT_VERSION, floorplans: [] };
      }
      throw new FloorplanStoreError("floorplan_store_read_failed", err?.message || "failed to read floorplans file");
    }
  }

  async save({ version, floorplans }) {
    const resolved = this.resolvePath();
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${resolved}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = JSON.stringify(
      {
        version: Number.isFinite(version) && version > 0 ? version : DEFAULT_VERSION,
        floorplans
      },
      null,
      2
    );
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, resolved);
  }
}

function normalizeFloorplans(parsed) {
  if (Array.isArray(parsed)) {
    return { version: DEFAULT_VERSION, floorplans: parsed };
  }
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.floorplans)) {
      const version = Number.isFinite(parsed.version) && parsed.version > 0 ? parsed.version : DEFAULT_VERSION;
      return { version, floorplans: parsed.floorplans };
    }
  }
  return { version: DEFAULT_VERSION, floorplans: [] };
}

function validateFloorplanList(list) {
  const errors = [];
  if (!Array.isArray(list)) {
    throw new FloorplanStoreError("invalid_floorplan", "floorplans must be an array");
  }

  const ids = new Set();

  list.forEach((plan, planIndex) => {
    const prefix = `floorplans[${planIndex}]`;
    if (!isPlainObject(plan)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    const planId = String(plan.id || "").trim();
    if (!planId) {
      errors.push(`${prefix}.id is required`);
    } else if (ids.has(planId)) {
      errors.push(`floorplan id duplicate: ${planId}`);
    } else {
      ids.add(planId);
    }

    if (typeof plan.name !== "string" || !plan.name.trim()) {
      errors.push(`${prefix}.name is required`);
    }

    if (!isPlainObject(plan.image)) {
      errors.push(`${prefix}.image is required`);
    } else {
      validateAsset(plan.image, `${prefix}.image`, errors);
    }

    if (plan.model !== undefined) {
      if (!isPlainObject(plan.model)) {
        errors.push(`${prefix}.model must be an object`);
      } else {
        validateAsset(plan.model, `${prefix}.model`, errors);
      }
    }

    if (plan.modelTransform !== undefined && plan.modelTransform !== null) {
      validateModelTransform(plan.modelTransform, `${prefix}.modelTransform`, errors);
    }

    if (plan.calibrationPoints !== undefined && plan.calibrationPoints !== null) {
      validateCalibrationPoints(plan.calibrationPoints, `${prefix}.calibrationPoints`, errors);
    }

    if (!Array.isArray(plan.rooms)) {
      errors.push(`${prefix}.rooms must be an array`);
    }

    if (!Array.isArray(plan.devices)) {
      errors.push(`${prefix}.devices must be an array`);
    }

    const roomIds = new Set();
    if (Array.isArray(plan.rooms)) {
      plan.rooms.forEach((room, roomIndex) => {
        const roomPrefix = `${prefix}.rooms[${roomIndex}]`;
        if (!isPlainObject(room)) {
          errors.push(`${roomPrefix} must be an object`);
          return;
        }
        const roomId = String(room.id || "").trim();
        if (!roomId) {
          errors.push(`${roomPrefix}.id is required`);
        } else if (roomIds.has(roomId)) {
          errors.push(`${roomPrefix}.id duplicate: ${roomId}`);
        } else {
          roomIds.add(roomId);
        }
        if (typeof room.name !== "string" || !room.name.trim()) {
          errors.push(`${roomPrefix}.name is required`);
        }
        if (!Array.isArray(room.polygon) || room.polygon.length < 3) {
          errors.push(`${roomPrefix}.polygon must be an array with at least 3 points`);
        } else {
          room.polygon.forEach((point, pointIndex) => {
            validatePoint2d(point, `${roomPrefix}.polygon[${pointIndex}]`, errors, true);
          });
        }
      });
    }

    const deviceIds = new Set();
    if (Array.isArray(plan.devices)) {
      plan.devices.forEach((device, deviceIndex) => {
        const devicePrefix = `${prefix}.devices[${deviceIndex}]`;
        if (!isPlainObject(device)) {
          errors.push(`${devicePrefix} must be an object`);
          return;
        }
        const deviceId = String(device.deviceId || "").trim();
        if (!deviceId) {
          errors.push(`${devicePrefix}.deviceId is required`);
        } else if (deviceIds.has(deviceId)) {
          errors.push(`${devicePrefix}.deviceId duplicate: ${deviceId}`);
        } else {
          deviceIds.add(deviceId);
        }
        validatePoint2d(device, devicePrefix, errors, true);
        if (device.height !== undefined && (!Number.isFinite(device.height) || device.height < 0)) {
          errors.push(`${devicePrefix}.height must be a non-negative number`);
        }
        if (device.rotation !== undefined && !Number.isFinite(device.rotation)) {
          errors.push(`${devicePrefix}.rotation must be a number`);
        }
        if (device.scale !== undefined && (!Number.isFinite(device.scale) || device.scale <= 0)) {
          errors.push(`${devicePrefix}.scale must be a positive number`);
        }
        if (device.roomId !== undefined && device.roomId !== null && String(device.roomId || "").trim()) {
          const roomId = String(device.roomId || "").trim();
          if (!roomIds.has(roomId)) {
            errors.push(`${devicePrefix}.roomId ${roomId} does not exist`);
          }
        }
      });
    }
  });

  if (errors.length) {
    throw new FloorplanStoreError("invalid_floorplan", errors.join("; "), { details: errors });
  }
}

function validateAsset(asset, prefix, errors) {
  const url = String(asset.url || "").trim();
  if (!url) {
    errors.push(`${prefix}.url is required`);
  }
  if (asset.width !== undefined && (!Number.isFinite(asset.width) || asset.width <= 0)) {
    errors.push(`${prefix}.width must be a positive number`);
  }
  if (asset.height !== undefined && (!Number.isFinite(asset.height) || asset.height <= 0)) {
    errors.push(`${prefix}.height must be a positive number`);
  }
  if (asset.size !== undefined && (!Number.isFinite(asset.size) || asset.size < 0)) {
    errors.push(`${prefix}.size must be a non-negative number`);
  }
}

function validateModelTransform(transform, prefix, errors) {
  if (!isPlainObject(transform)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (!Array.isArray(transform.matrix) || transform.matrix.length !== 4) {
    errors.push(`${prefix}.matrix must be an array of 4 numbers`);
  } else {
    transform.matrix.forEach((value, idx) => {
      if (!Number.isFinite(value)) {
        errors.push(`${prefix}.matrix[${idx}] must be a number`);
      }
    });
  }
  if (!isPlainObject(transform.translate)) {
    errors.push(`${prefix}.translate must be an object`);
  } else {
    if (!Number.isFinite(transform.translate.x)) {
      errors.push(`${prefix}.translate.x must be a number`);
    }
    if (!Number.isFinite(transform.translate.z)) {
      errors.push(`${prefix}.translate.z must be a number`);
    }
  }
}

function validateCalibrationPoints(calibration, prefix, errors) {
  if (!isPlainObject(calibration)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (!Array.isArray(calibration.image) || calibration.image.length !== 3) {
    errors.push(`${prefix}.image must be an array of 3 points`);
  } else {
    calibration.image.forEach((point, idx) => {
      validatePoint2d(point, `${prefix}.image[${idx}]`, errors, true);
    });
  }
  if (!Array.isArray(calibration.model) || calibration.model.length !== 3) {
    errors.push(`${prefix}.model must be an array of 3 points`);
  } else {
    calibration.model.forEach((point, idx) => {
      validatePoint3d(point, `${prefix}.model[${idx}]`, errors);
    });
  }
}

function validatePoint2d(point, prefix, errors, requireRange) {
  if (!isPlainObject(point)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (!Number.isFinite(point.x)) {
    errors.push(`${prefix}.x must be a number`);
  } else if (requireRange && (point.x < 0 || point.x > 1)) {
    errors.push(`${prefix}.x must be between 0 and 1`);
  }
  if (!Number.isFinite(point.y)) {
    errors.push(`${prefix}.y must be a number`);
  } else if (requireRange && (point.y < 0 || point.y > 1)) {
    errors.push(`${prefix}.y must be between 0 and 1`);
  }
}

function validatePoint3d(point, prefix, errors) {
  if (!isPlainObject(point)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (!Number.isFinite(point.x)) {
    errors.push(`${prefix}.x must be a number`);
  }
  if (!Number.isFinite(point.y)) {
    errors.push(`${prefix}.y must be a number`);
  }
  if (!Number.isFinite(point.z)) {
    errors.push(`${prefix}.z must be a number`);
  }
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
