export function normalizeFloorplanId(value) {
  const id = String(value || "").trim();
  return id || "";
}

export function getFloorplanDeviceIds(plan) {
  const ids = new Set();
  for (const entry of plan?.devices || []) {
    const deviceId = String(entry?.deviceId || "").trim();
    if (!deviceId) continue;
    ids.add(deviceId);
  }
  return ids;
}

export function filterDevicesForFloorplan(devices, plan) {
  const ids = getFloorplanDeviceIds(plan);
  return (devices || []).filter((device) => {
    if (ids.has(String(device?.id || "").trim())) return true;
    if (device?.composition?.role !== "relay_channel") return false;
    return ids.has(String(device?.composition?.parentId || "").trim());
  });
}

export function getSceneScopeFloorplanIds(scene) {
  const seen = new Set();
  const out = [];
  for (const value of scene?.scope?.floorplanIds || []) {
    const id = normalizeFloorplanId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function sceneMatchesFloorplan(scene, floorplanId) {
  const expected = normalizeFloorplanId(floorplanId);
  if (!expected) return true;
  return getSceneScopeFloorplanIds(scene).includes(expected);
}
