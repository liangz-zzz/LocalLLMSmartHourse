export const FLOORPLAN_COORDINATE_UNIT = "m";
export const FLOORPLAN_COORDINATE_FRAME = "floorplan_image";
export const FLOORPLAN_COORDINATE_SOURCE = "floorplan";

export function getFloorplanScaleMetrics(plan) {
  const width = Number(plan?.image?.width);
  const height = Number(plan?.image?.height);
  const points = plan?.imageScale?.points;
  const distanceMeters = Number(plan?.imageScale?.distanceMeters);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
  if (!Array.isArray(points) || points.length !== 2 || !Number.isFinite(distanceMeters) || distanceMeters <= 0) return null;

  const [a, b] = points;
  const dx = (Number(b?.x) - Number(a?.x)) * width;
  const dy = (Number(b?.y) - Number(a?.y)) * height;
  const pixelDistance = Math.hypot(dx, dy);
  if (!Number.isFinite(pixelDistance) || pixelDistance < 1) return null;

  return {
    width,
    height,
    pixelDistance,
    distanceMeters,
    metersPerPixel: distanceMeters / pixelDistance,
    pixelsPerMeter: pixelDistance / distanceMeters
  };
}

export function calculateFloorplanDeviceCoordinates(plan, device) {
  const metrics = getFloorplanScaleMetrics(plan);
  const x = Number(device?.x);
  const y = Number(device?.y);
  const z = device?.height === undefined ? 0 : Number(device.height);
  const floorplanId = String(plan?.id || "").trim();
  if (!metrics || !floorplanId || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;

  return {
    x: x * metrics.width * metrics.metersPerPixel,
    y: y * metrics.height * metrics.metersPerPixel,
    z,
    unit: FLOORPLAN_COORDINATE_UNIT,
    frame: FLOORPLAN_COORDINATE_FRAME,
    floorplanId,
    source: FLOORPLAN_COORDINATE_SOURCE
  };
}

export function buildFloorplanCoordinateMap(floorplans) {
  const coordinates = new Map();
  for (const plan of Array.isArray(floorplans) ? floorplans : []) {
    for (const device of Array.isArray(plan?.devices) ? plan.devices : []) {
      const deviceId = String(device?.deviceId || "").trim();
      if (!deviceId) continue;
      const value = calculateFloorplanDeviceCoordinates(plan, device);
      if (value) coordinates.set(deviceId, value);
    }
  }
  return coordinates;
}

export function isFloorplanCoordinates(value) {
  return Boolean(value && typeof value === "object" && value.source === FLOORPLAN_COORDINATE_SOURCE);
}
