export const CURRENT_FLOORPLAN_STORAGE_KEY = "smarthouse.currentFloorplanId";

export type FloorplanAsset = {
  assetId?: string;
  url: string;
  width?: number;
  height?: number;
  mime?: string;
  size?: number;
};

export type FloorplanRoom = {
  id: string;
  name: string;
  polygon: Array<{ x: number; y: number }>;
};

export type FloorplanDevicePlacement = {
  deviceId: string;
  x: number;
  y: number;
  roomId?: string;
  height?: number;
};

export type FloorplanSummary = {
  id: string;
  name: string;
  image?: FloorplanAsset;
  roomCount: number;
  deviceCount: number;
};

export type Floorplan = {
  id: string;
  name: string;
  image: FloorplanAsset;
  rooms: FloorplanRoom[];
  devices: FloorplanDevicePlacement[];
};

export function getStoredFloorplanId() {
  if (typeof window === "undefined") return "";
  return String(window.localStorage.getItem(CURRENT_FLOORPLAN_STORAGE_KEY) || "").trim();
}

export function setStoredFloorplanId(floorplanId: string) {
  if (typeof window === "undefined") return;
  const value = String(floorplanId || "").trim();
  if (!value) {
    window.localStorage.removeItem(CURRENT_FLOORPLAN_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(CURRENT_FLOORPLAN_STORAGE_KEY, value);
}

export function resolveInitialFloorplanId(floorplans: FloorplanSummary[], preferredId?: string) {
  const preferred = String(preferredId || "").trim();
  if (preferred && floorplans.some((floorplan) => floorplan.id === preferred)) {
    return preferred;
  }
  return floorplans[0]?.id || "";
}
