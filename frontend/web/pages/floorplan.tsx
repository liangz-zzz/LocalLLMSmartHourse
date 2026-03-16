import Head from "next/head";
import Script from "next/script";
import { useRouter } from "next/router";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { Device } from "../lib/device-types";
import { getDeviceExternalLinks } from "../lib/integrations";

type Point2D = { x: number; y: number };
type Point3D = { x: number; y: number; z: number };

type FloorplanAsset = {
  assetId?: string;
  url: string;
  width?: number;
  height?: number;
  mime?: string;
  size?: number;
};

type ModelTransform = {
  matrix: [number, number, number, number];
  translate: { x: number; z: number };
};

type CalibrationPoints = {
  image: Point2D[];
  model: Point3D[];
};

type ImageScaleReference = {
  points: [Point2D, Point2D];
  distanceMeters: number;
};

type FloorplanRoom = {
  id: string;
  name: string;
  polygon: Point2D[];
};

type FloorplanDevice = {
  deviceId: string;
  x: number;
  y: number;
  height?: number;
  rotation?: number;
  scale?: number;
  roomId?: string;
};

type Floorplan = {
  id: string;
  name: string;
  image: FloorplanAsset;
  model?: FloorplanAsset;
  modelTransform?: ModelTransform | null;
  calibrationPoints?: CalibrationPoints | null;
  imageScale?: ImageScaleReference | null;
  rooms: FloorplanRoom[];
  devices: FloorplanDevice[];
};

type FloorplanSummary = {
  id: string;
  name: string;
  image: FloorplanAsset;
  model?: FloorplanAsset;
  roomCount?: number;
  deviceCount?: number;
};

type SceneSummary = {
  id: string;
  name: string;
  description?: string;
};

type SceneStep = {
  type: "device";
  deviceId: string;
  action: string;
  params?: Record<string, any>;
};

type ScenePreview = {
  sceneId: string;
  steps: SceneStep[];
};

type SceneEffect = {
  color: string;
  label: string;
};

type VirtualDevice = {
  id?: string;
  name?: string;
  placement?: { room?: string; zone?: string; description?: string };
  protocol?: string;
  bindings?: Record<string, any>;
  traits?: Record<string, any>;
  capabilities?: { action: string; parameters?: any[] }[];
  semantics?: Record<string, any>;
  model_template_id?: string;
  simulation?: { latency_ms?: number; failure_rate?: number; transitions?: Record<string, any> };
};

type VirtualDeviceModel = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  placement?: { room?: string; zone?: string; description?: string };
  protocol?: string;
  bindings?: Record<string, any>;
  traits?: Record<string, any>;
  capabilities?: { action: string; parameters?: any[] }[];
  semantics?: Record<string, any>;
  simulation?: { latency_ms?: number; failure_rate?: number; transitions?: Record<string, any> };
};

type VirtualConfig = {
  enabled: boolean;
  defaults: { latency_ms: number; failure_rate: number };
  devices: VirtualDevice[];
};

type SceneRunStepResult = {
  index: number;
  deviceId: string;
  action: string;
  status: "ok" | "error" | "timeout" | "queued" | "dry_run";
  reason?: string;
};

type SceneRunResult = {
  runId: string;
  sceneId: string;
  status: string;
  steps: SceneRunStepResult[];
  durationMs?: number;
};

type Mode = "view" | "rooms" | "devices" | "calibration";
type PageStage = "browse" | "editor";
type BrowseView = "select" | "create";

const MODE_LABELS: Record<Mode, string> = {
  view: "视图",
  rooms: "房间编辑",
  devices: "设备编辑",
  calibration: "校准"
};

const pageBg = "linear-gradient(135deg, #f7f3ea 0%, #f0f4f5 50%, #e6eef0 100%)";

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function toNormalizedPoint(evt: ReactPointerEvent, rect: DOMRect): Point2D {
  const x = clamp01((evt.clientX - rect.left) / rect.width);
  const y = clamp01((evt.clientY - rect.top) / rect.height);
  return { x, y };
}

function resolveAssetUrl(url: string) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/assets/")) return `/api${url}`;
  return url;
}

function polygonArea(points: Point2D[]) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length];
    const cur = points[i];
    area += cur.x * next.y - next.x * cur.y;
  }
  return Math.abs(area / 2);
}

function pointInPolygon(point: Point2D, polygon: Point2D[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function findRoomForPoint(rooms: FloorplanRoom[], point: Point2D) {
  const hits = rooms
    .filter((room) => pointInPolygon(point, room.polygon))
    .map((room) => ({ room, area: polygonArea(room.polygon) }))
    .sort((a, b) => a.area - b.area);
  return hits.length ? hits[0].room.id : "";
}

function getPointDistanceInPixels(a: Point2D, b: Point2D, imageWidth: number, imageHeight: number) {
  const dx = (b.x - a.x) * imageWidth;
  const dy = (b.y - a.y) * imageHeight;
  return Math.sqrt(dx * dx + dy * dy);
}

function getImageScaleMetrics(scale: ImageScaleReference | null | undefined, imageWidth: number, imageHeight: number) {
  if (!scale?.points?.length || scale.points.length !== 2) return null;
  const pixelDistance = getPointDistanceInPixels(scale.points[0], scale.points[1], imageWidth, imageHeight);
  if (!Number.isFinite(pixelDistance) || pixelDistance <= 0) return null;
  const distanceMeters = Number(scale.distanceMeters);
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return null;
  return {
    pixelDistance,
    distanceMeters,
    metersPerPixel: distanceMeters / pixelDistance,
    pixelsPerMeter: pixelDistance / distanceMeters
  };
}

function slugify(name: string) {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]+/g, "")
    .replace(/\s+/g, "_");
  return cleaned || `floorplan_${Date.now()}`;
}

function computeTransform(imagePoints: Point2D[], modelPoints: Point3D[]): ModelTransform | null {
  if (imagePoints.length !== 3 || modelPoints.length !== 3) return null;
  const [u1, u2, u3] = imagePoints;
  const [v1, v2, v3] = modelPoints;

  const a = u2.x - u1.x;
  const b = u3.x - u1.x;
  const c = u2.y - u1.y;
  const d = u3.y - u1.y;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-6) return null;

  const inv00 = d / det;
  const inv01 = -b / det;
  const inv10 = -c / det;
  const inv11 = a / det;

  const vx1 = v2.x - v1.x;
  const vx2 = v3.x - v1.x;
  const vz1 = v2.z - v1.z;
  const vz2 = v3.z - v1.z;

  const m00 = vx1 * inv00 + vx2 * inv10;
  const m01 = vx1 * inv01 + vx2 * inv11;
  const m10 = vz1 * inv00 + vz2 * inv10;
  const m11 = vz1 * inv01 + vz2 * inv11;

  const tx = v1.x - (m00 * u1.x + m01 * u1.y);
  const tz = v1.z - (m10 * u1.x + m11 * u1.y);

  return {
    matrix: [m00, m01, m10, m11],
    translate: { x: tx, z: tz }
  };
}

function mapTo3d(point: Point2D, transform?: ModelTransform | null) {
  if (!transform) return null;
  const [m00, m01, m10, m11] = transform.matrix;
  const x = m00 * point.x + m01 * point.y + transform.translate.x;
  const z = m10 * point.x + m11 * point.y + transform.translate.z;
  return { x, z };
}

function buildSceneEffects(steps: SceneStep[]): Record<string, SceneEffect> {
  const effects: Record<string, SceneEffect> = {};
  for (const step of steps) {
    const action = step.action || "";
    const params = step.params || {};
    if (action === "turn_on" || action === "toggle") {
      effects[step.deviceId] = { color: "#22c55e", label: "开启" };
      continue;
    }
    if (action === "turn_off") {
      effects[step.deviceId] = { color: "#ef4444", label: "关闭" };
      continue;
    }
    if (action === "set_brightness") {
      const value = params.brightness ?? params.level;
      effects[step.deviceId] = { color: "#f59e0b", label: `亮度 ${value ?? ""}`.trim() };
      continue;
    }
    if (action === "set_color_temp") {
      const value = params.color_temp ?? params.kelvin;
      effects[step.deviceId] = { color: "#38bdf8", label: `色温 ${value ?? ""}`.trim() };
      continue;
    }
    if (action === "set_color") {
      const r = params.r ?? params.red;
      const g = params.g ?? params.green;
      const b = params.b ?? params.blue;
      const color = Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? `rgb(${r}, ${g}, ${b})` : "#f97316";
      effects[step.deviceId] = { color, label: "颜色" };
      continue;
    }
    if (action === "set_cover_position") {
      const value = params.position ?? params.percent;
      effects[step.deviceId] = { color: "#0ea5e9", label: `窗帘 ${value ?? ""}`.trim() };
      continue;
    }
    if (action === "set_temperature" || action === "set_hvac_mode" || action === "set_fan_mode") {
      const value = params.temperature ?? params.mode ?? params.fan;
      effects[step.deviceId] = { color: "#fb7185", label: `空调 ${value ?? ""}`.trim() };
      continue;
    }
    effects[step.deviceId] = { color: "#64748b", label: action || "动作" };
  }
  return effects;
}

function tryParseObject(text: string) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function cloneValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function serializeCapabilityActions(capabilities?: { action: string }[]) {
  if (!Array.isArray(capabilities) || !capabilities.length) return "turn_on, turn_off";
  return capabilities
    .map((item) => String(item?.action || "").trim())
    .filter(Boolean)
    .join(", ");
}

function buildVirtualDraftFromModel({
  id,
  defaults,
  model
}: {
  id: string;
  defaults: { latency_ms: number; failure_rate: number };
  model?: VirtualDeviceModel | null;
}): VirtualDevice {
  if (!model) {
    return {
      id,
      name: "",
      placement: { room: "living_room", zone: "" },
      protocol: "virtual",
      bindings: {},
      traits: { switch: { state: "off" } },
      capabilities: [{ action: "turn_on" }, { action: "turn_off" }],
      simulation: {
        latency_ms: Number(defaults.latency_ms || 120),
        failure_rate: Number(defaults.failure_rate || 0)
      }
    };
  }

  const modelSimulation = model.simulation && typeof model.simulation === "object" ? cloneValue(model.simulation) : {};
  return {
    id,
    name: model.name || "",
    model_template_id: model.id,
    placement: {
      room: String(model.placement?.room || "living_room"),
      zone: String(model.placement?.zone || ""),
      description: String(model.placement?.description || "")
    },
    protocol: String(model.protocol || "virtual").trim() || "virtual",
    bindings: cloneValue(model.bindings || {}),
    traits: cloneValue(model.traits || {}),
    capabilities: Array.isArray(model.capabilities) ? cloneValue(model.capabilities) : [],
    semantics: cloneValue(model.semantics || {}),
    simulation: {
      ...(modelSimulation || {}),
      latency_ms: Number(modelSimulation?.latency_ms ?? defaults.latency_ms ?? 120),
      failure_rate: Number(modelSimulation?.failure_rate ?? defaults.failure_rate ?? 0)
    }
  };
}

function ThreePreview({
  modelUrl,
  transform,
  devices,
  calibrationPoints,
  mode,
  sceneEffects,
  onPickPoint,
  selectedDeviceId
}: {
  modelUrl?: string;
  transform?: ModelTransform | null;
  devices: FloorplanDevice[];
  calibrationPoints: CalibrationPoints;
  mode: Mode;
  sceneEffects: Record<string, SceneEffect>;
  onPickPoint?: (point: Point3D) => void;
  selectedDeviceId?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const threeRef = useRef<{
    THREE?: any;
    scene?: any;
    camera?: any;
    renderer?: any;
    controls?: any;
    loader?: any;
    raycaster?: any;
    model?: any;
    meshes?: any[];
    markers?: Map<string, any>;
    calibrationMarkers?: any[];
    resize?: () => void;
    cleanup?: () => void;
  }>({});

  useEffect(() => {
    let canceled = false;
    const setup = async () => {
      if (!containerRef.current) return;
      const THREE = await import(/* webpackIgnore: true */ "/vendor/three/three.module.js");
      const { GLTFLoader } = await import(/* webpackIgnore: true */ "/vendor/three/GLTFLoader.js");
      const { OrbitControls } = await import(/* webpackIgnore: true */ "/vendor/three/OrbitControls.js");
      if (canceled || !containerRef.current) return;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#f6f3ea");
      const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
      camera.position.set(6, 6, 6);
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
      containerRef.current.innerHTML = "";
      containerRef.current.appendChild(renderer.domElement);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.target.set(0, 0, 0);

      const ambient = new THREE.AmbientLight(0xffffff, 0.7);
      scene.add(ambient);
      const directional = new THREE.DirectionalLight(0xffffff, 0.6);
      directional.position.set(5, 10, 7);
      scene.add(directional);
      const grid = new THREE.GridHelper(20, 20, "#d6d3d1", "#e2e8f0");
      grid.position.y = 0;
      scene.add(grid);

      const raycaster = new THREE.Raycaster();
      const meshes: any[] = [];
      const markers = new Map<string, any>();
      const calibrationMarkers: any[] = [];
      const loader = new GLTFLoader();

      const animate = () => {
        controls.update();
        renderer.render(scene, camera);
      };
      renderer.setAnimationLoop(animate);

      const resize = () => {
        if (!containerRef.current) return;
        const { clientWidth, clientHeight } = containerRef.current;
        renderer.setSize(clientWidth, clientHeight);
        camera.aspect = clientWidth / clientHeight;
        camera.updateProjectionMatrix();
      };

      const onResize = () => resize();
      window.addEventListener("resize", onResize);

      threeRef.current = {
        THREE,
        scene,
        camera,
        renderer,
        controls,
        loader,
        raycaster,
        meshes,
        markers,
        calibrationMarkers,
        resize,
        cleanup: () => {
          window.removeEventListener("resize", onResize);
          renderer.setAnimationLoop(null);
          renderer.dispose();
          scene.clear();
          controls.dispose();
        }
      };
      resize();
    };

    setup();
    return () => {
      canceled = true;
      threeRef.current.cleanup?.();
    };
  }, []);

  useEffect(() => {
    const state = threeRef.current;
    if (!state.loader || !state.scene || !state.THREE) return;
    if (!modelUrl) return;

    const currentModel = state.model;
    if (currentModel) {
      state.scene.remove(currentModel);
      state.model = undefined;
      state.meshes = [];
    }

    state.loader.load(
      modelUrl,
      (gltf: any) => {
        if (!state.scene) return;
        state.model = gltf.scene;
        state.meshes = [];
        gltf.scene.traverse((child: any) => {
          if (child.isMesh) {
            state.meshes?.push(child);
          }
        });
        state.scene.add(gltf.scene);
      },
      undefined,
      () => {
        // ignore load errors for now
      }
    );
  }, [modelUrl]);

  useEffect(() => {
    const state = threeRef.current;
    if (!state.renderer || !state.raycaster || !state.camera) return;
    const dom = state.renderer.domElement;

    const handlePointer = (evt: PointerEvent) => {
      if (mode !== "calibration") return;
      if (!state.meshes?.length) return;
      if (calibrationPoints.model.length >= 3) return;
      const rect = dom.getBoundingClientRect();
      const x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((evt.clientY - rect.top) / rect.height) * 2 + 1;
      state.raycaster.setFromCamera({ x, y }, state.camera);
      const hit = state.raycaster.intersectObjects(state.meshes, true)[0];
      if (hit && onPickPoint) {
        onPickPoint({ x: hit.point.x, y: hit.point.y, z: hit.point.z });
      }
    };

    dom.addEventListener("pointerdown", handlePointer);
    return () => {
      dom.removeEventListener("pointerdown", handlePointer);
    };
  }, [mode, calibrationPoints.model.length, onPickPoint]);

  useEffect(() => {
    const state = threeRef.current;
    if (!state.scene || !state.THREE) return;

    const markers = state.markers || new Map();
    state.markers = markers;
    const deviceIds = new Set(devices.map((d) => d.deviceId));

    for (const [id, mesh] of markers.entries()) {
      if (!deviceIds.has(id)) {
        state.scene.remove(mesh);
        markers.delete(id);
      }
    }

    devices.forEach((device) => {
      const effect = sceneEffects[device.deviceId];
      const highlightColor = effect?.color || "#0f172a";
      const color = device.deviceId === selectedDeviceId ? "#111827" : highlightColor;
      const pos2d = { x: device.x, y: device.y };
      const pos3d = mapTo3d(pos2d, transform);
      if (!pos3d) return;
      let marker = markers.get(device.deviceId);
      if (!marker) {
        const geometry = new state.THREE.SphereGeometry(0.1, 16, 16);
        const material = new state.THREE.MeshStandardMaterial({ color });
        marker = new state.THREE.Mesh(geometry, material);
        markers.set(device.deviceId, marker);
        state.scene.add(marker);
      } else {
        marker.material.color.set(color);
      }
      const scale = device.scale ?? 1;
      marker.scale.set(scale, scale, scale);
      marker.position.set(pos3d.x, device.height ?? 0, pos3d.z);
    });
  }, [devices, transform, sceneEffects, selectedDeviceId]);

  useEffect(() => {
    const state = threeRef.current;
    if (!state.scene || !state.THREE) return;

    state.calibrationMarkers?.forEach((marker: any) => state.scene.remove(marker));
    state.calibrationMarkers = [];

    calibrationPoints.model.forEach((point) => {
      const geometry = new state.THREE.SphereGeometry(0.08, 12, 12);
      const material = new state.THREE.MeshStandardMaterial({ color: "#f97316" });
      const marker = new state.THREE.Mesh(geometry, material);
      marker.position.set(point.x, point.y, point.z);
      state.scene.add(marker);
      state.calibrationMarkers?.push(marker);
    });
  }, [calibrationPoints]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%", borderRadius: "16px", overflow: "hidden" }} />;
}

export default function FloorplanPage() {
  const router = useRouter();
  const [pageStage, setPageStage] = useState<PageStage>("browse");
  const [browseView, setBrowseView] = useState<BrowseView>("select");
  const [mode, setMode] = useState<Mode>("view");
  const [floorplans, setFloorplans] = useState<FloorplanSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Floorplan | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<string>("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [scenePreview, setScenePreview] = useState<ScenePreview | null>(null);
  const [sceneEffects, setSceneEffects] = useState<Record<string, SceneEffect>>({});
  const [sceneRunResult, setSceneRunResult] = useState<SceneRunResult | null>(null);
  const [sceneRunLoading, setSceneRunLoading] = useState<boolean>(false);
  const [status, setStatus] = useState<string>("");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [draftRoomPoints, setDraftRoomPoints] = useState<Point2D[]>([]);
  const [draftRoomName, setDraftRoomName] = useState<string>("");
  const [isDrawingRoom, setIsDrawingRoom] = useState<boolean>(false);
  const [placingDeviceId, setPlacingDeviceId] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<CalibrationPoints>({ image: [], model: [] });
  const [imageDims, setImageDims] = useState<{ width: number; height: number } | null>(null);

  const [deviceOverrideDraft, setDeviceOverrideDraft] = useState<any | null>(null);
  const [deviceOverrideStatus, setDeviceOverrideStatus] = useState<string>("");
  const [deviceOverrideSaving, setDeviceOverrideSaving] = useState<boolean>(false);

  const [virtualConfig, setVirtualConfig] = useState<VirtualConfig>({
    enabled: false,
    defaults: { latency_ms: 120, failure_rate: 0 },
    devices: []
  });
  const [virtualModels, setVirtualModels] = useState<VirtualDeviceModel[]>([]);
  const [selectedVirtualModelId, setSelectedVirtualModelId] = useState<string>("");
  const [selectedVirtualModelEditId, setSelectedVirtualModelEditId] = useState<string>("");
  const [virtualModelDraft, setVirtualModelDraft] = useState<VirtualDeviceModel | null>(null);
  const [virtualModelTraitsText, setVirtualModelTraitsText] = useState<string>("{}");
  const [virtualModelActionsText, setVirtualModelActionsText] = useState<string>("turn_on, turn_off");
  const [virtualModelStatus, setVirtualModelStatus] = useState<string>("");
  const [virtualModelSaving, setVirtualModelSaving] = useState<boolean>(false);
  const [selectedVirtualId, setSelectedVirtualId] = useState<string>("");
  const [virtualDraft, setVirtualDraft] = useState<VirtualDevice | null>(null);
  const [virtualTraitsText, setVirtualTraitsText] = useState<string>("{}");
  const [virtualActionsText, setVirtualActionsText] = useState<string>("turn_on, turn_off");
  const [virtualStatus, setVirtualStatus] = useState<string>("");
  const [virtualSaving, setVirtualSaving] = useState<boolean>(false);

  const [newPlanName, setNewPlanName] = useState<string>("");
  const [newPlanId, setNewPlanId] = useState<string>("");
  const [newImageAsset, setNewImageAsset] = useState<FloorplanAsset | null>(null);
  const [newModelAsset, setNewModelAsset] = useState<FloorplanAsset | null>(null);
  const [newImageUploading, setNewImageUploading] = useState<boolean>(false);
  const [newModelUploading, setNewModelUploading] = useState<boolean>(false);
  const [newImageUploadError, setNewImageUploadError] = useState<string>("");
  const [newModelUploadError, setNewModelUploadError] = useState<string>("");
  const [show3dPanel, setShow3dPanel] = useState<boolean>(false);
  const [canvasZoom, setCanvasZoom] = useState<number>(1);
  const [canvasViewportSize, setCanvasViewportSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [isSettingImageScale, setIsSettingImageScale] = useState<boolean>(false);
  const [draftScalePoints, setDraftScalePoints] = useState<Point2D[]>([]);
  const [scaleDistanceInput, setScaleDistanceInput] = useState<string>("");

  const svgRef = useRef<SVGSVGElement | null>(null);
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const draggingDeviceRef = useRef<string | null>(null);
  const draggingHandleRef = useRef<{ roomId: string; index: number } | null>(null);
  const replaceImageInputRef = useRef<HTMLInputElement | null>(null);
  const replaceModelInputRef = useRef<HTMLInputElement | null>(null);

  const deviceMap = useMemo(() => {
    const map: Record<string, Device> = {};
    devices.forEach((device) => {
      map[device.id] = device;
    });
    return map;
  }, [devices]);

  const isDirty = useMemo(() => {
    if (!draft) return false;
    return JSON.stringify(draft) !== savedSnapshot;
  }, [draft, savedSnapshot]);

  const refreshFloorplans = async () => {
    const res = await fetch("/api/floorplans");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.reason || data?.error || "加载户型失败");
    const items = Array.isArray(data?.items) ? data.items : [];
    setFloorplans(items);
    return items;
  };

  const refreshDevices = async () => {
    const res = await fetch("/api/devices");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.reason || data?.error || "加载设备失败");
    setDevices(data.items || []);
  };

  const resetEditorTransientState = () => {
    setDraftRoomPoints([]);
    setDraftRoomName("");
    setIsDrawingRoom(false);
    setPlacingDeviceId(null);
    setSelectedRoomId(null);
    setSelectedDeviceId(null);
    setScenePreview(null);
    setSceneEffects({});
    setSceneRunResult(null);
    setDeviceOverrideDraft(null);
    setDeviceOverrideStatus("");
    setCanvasZoom(1);
    setShow3dPanel(false);
    setIsSettingImageScale(false);
    setDraftScalePoints([]);
    setScaleDistanceInput("");
  };

  const clearEditorState = () => {
    resetEditorTransientState();
    setDraft(null);
    setSavedSnapshot("");
    setActiveId(null);
    setCalibration({ image: [], model: [] });
    setImageDims(null);
    setMode("view");
  };

  const enterEditor = (floorplanId: string) => {
    resetEditorTransientState();
    setActiveId(floorplanId);
    setPageStage("editor");
    setBrowseView("select");
    setMode("view");
    setStatus("");
  };

  const returnToBrowse = () => {
    if (isDirty && !window.confirm("当前户型有未保存修改，确认返回户型选择吗？")) return;
    clearEditorState();
    setPageStage("browse");
    setStatus("");
  };

  const loadVirtualConfig = async (preferredId?: string) => {
    const res = await fetch("/api/virtual-devices/config");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.reason || data?.error || "加载模拟设备配置失败");
    const next: VirtualConfig = {
      enabled: data?.enabled === true,
      defaults: {
        latency_ms: Number(data?.defaults?.latency_ms ?? 120),
        failure_rate: Number(data?.defaults?.failure_rate ?? 0)
      },
      devices: Array.isArray(data?.devices) ? data.devices : []
    };
    setVirtualConfig(next);
    const currentId = preferredId !== undefined ? preferredId : selectedVirtualId;
    if (currentId && !next.devices.some((item) => item.id === currentId)) {
      setSelectedVirtualId("");
    }
    if (currentId && next.devices.some((item) => item.id === currentId)) {
      setSelectedVirtualId(currentId);
    } else if (!currentId && next.devices.length) {
      setSelectedVirtualId(next.devices[0].id);
    }
  };

  const loadVirtualModels = async () => {
    const res = await fetch("/api/virtual-devices/models");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.reason || data?.error || "加载模拟设备型号失败");
    const items = Array.isArray(data?.items) ? data.items : [];
    setVirtualModels(items);
    setSelectedVirtualModelId((current) => {
      if (current && items.some((item: VirtualDeviceModel) => item.id === current)) return current;
      return items[0]?.id || "";
    });
    setSelectedVirtualModelEditId((current) => {
      if (current && items.some((item: VirtualDeviceModel) => item.id === current)) return current;
      return items[0]?.id || "";
    });
    if (!items.length) {
      setVirtualModelDraft(null);
    }
  };

  useEffect(() => {
    const load = async () => {
      try {
        await refreshFloorplans();
      } catch (err) {
        setStatus(`加载户型失败: ${(err as Error).message}`);
      }
    };
    load();
  }, []);

  useEffect(() => {
    const loadScenes = async () => {
      try {
        const res = await fetch("/api/scenes");
        const data = await res.json();
        setScenes(data.items || []);
      } catch (err) {
        setStatus(`加载场景失败: ${(err as Error).message}`);
      }
    };
    refreshDevices().catch((err) => {
      setStatus(`加载设备失败: ${(err as Error).message}`);
    });
    loadVirtualConfig().catch((err) => {
      setVirtualStatus((err as Error).message);
    });
    loadVirtualModels().catch((err) => {
      setVirtualStatus((err as Error).message);
    });
    loadScenes();
  }, []);

  useEffect(() => {
    if (pageStage !== "editor" || !activeId) return;
    const loadFloorplan = async () => {
      try {
        const res = await fetch(`/api/floorplans/${encodeURIComponent(activeId)}`);
        const data = await res.json();
        if (!res.ok) {
          setStatus(data?.error || "加载失败");
          return;
        }
        setDraft(data);
        setSavedSnapshot(JSON.stringify(data));
        setCalibration(data.calibrationPoints || { image: [], model: [] });
        setImageDims(data?.image?.width && data?.image?.height ? { width: data.image.width, height: data.image.height } : null);
        resetEditorTransientState();
        setScaleDistanceInput(data?.imageScale?.distanceMeters ? String(data.imageScale.distanceMeters) : "");
      } catch (err) {
        setStatus(`加载户型失败: ${(err as Error).message}`);
      }
    };
    loadFloorplan();
  }, [activeId, pageStage]);

  useEffect(() => {
    if (!draft?.image?.url) return;
    const img = new Image();
    img.onload = () => {
      setImageDims({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = resolveAssetUrl(draft.image.url);
  }, [draft?.image?.url]);

  useEffect(() => {
    if (!canvasViewportRef.current) return;
    const node = canvasViewportRef.current;
    const updateSize = () => {
      setCanvasViewportSize({
        width: node.clientWidth,
        height: node.clientHeight
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [pageStage, draft?.id]);

  useEffect(() => {
    if (pageStage !== "editor" || mode !== "view") return;
    let ws: WebSocket | null = null;
    let active = true;
    const connect = () => {
      if (!active) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const host = window.location.hostname;
      const port = process.env.NEXT_PUBLIC_WS_PORT || "4001";
      const wsUrl = process.env.NEXT_PUBLIC_WS_BASE || `${proto}://${host}:${port}/ws`;
      ws = new WebSocket(wsUrl);
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "device_update" || msg.type === "state_snapshot") {
            const d = msg.data;
            if (!d?.id) return;
            setDevices((prev) =>
              prev.map((device) => (device.id === d.id ? { ...device, ...d, traits: { ...device.traits, ...d.traits } } : device))
            );
          }
        } catch (_err) {
          // ignore
        }
      };
      ws.onclose = () => {
        if (active && pageStage === "editor" && mode === "view") setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      active = false;
      ws?.close();
    };
  }, [mode, pageStage]);

  useEffect(() => {
    if (calibration.image.length === 3 && calibration.model.length === 3) {
      const transform = computeTransform(calibration.image, calibration.model);
      if (!transform) {
        setStatus("校准失败：请确保三点不共线且分布分散");
      }
      updateDraft((prev) => ({
        ...prev,
        modelTransform: transform,
        calibrationPoints: calibration
      }));
    }
  }, [calibration.image.length, calibration.model.length]);

  useEffect(() => {
    if (mode !== "rooms") {
      setIsDrawingRoom(false);
      setDraftRoomPoints([]);
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== "devices") {
      setPlacingDeviceId(null);
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== "view") {
      setIsSettingImageScale(false);
      setDraftScalePoints([]);
    }
  }, [mode]);

  useEffect(() => {
    if (mode === "calibration") {
      setShow3dPanel(true);
    }
  }, [mode]);

  useEffect(() => {
    if (!selectedDeviceId) {
      setDeviceOverrideDraft(null);
      setDeviceOverrideStatus("");
      return;
    }
    let active = true;
    const load = async () => {
      setDeviceOverrideStatus("加载设备覆盖配置...");
      try {
        const resp = await fetch(`/api/device-overrides/${encodeURIComponent(selectedDeviceId)}`);
        const data = await resp.json().catch(() => ({}));
        if (!active) return;
        if (resp.status === 404) {
          setDeviceOverrideDraft({ id: selectedDeviceId, placement: {}, semantics: {} });
          setDeviceOverrideStatus("");
          return;
        }
        if (!resp.ok) {
          setDeviceOverrideDraft({ id: selectedDeviceId, placement: {}, semantics: {} });
          setDeviceOverrideStatus(data?.reason || data?.error || "加载失败");
          return;
        }
        setDeviceOverrideDraft(data);
        setDeviceOverrideStatus("");
      } catch (err) {
        if (!active) return;
        setDeviceOverrideStatus((err as Error).message);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [selectedDeviceId]);

  useEffect(() => {
    if (!selectedVirtualId) return;
    const found = virtualConfig.devices.find((item) => item.id === selectedVirtualId);
    if (!found) return;
    setVirtualDraft(cloneValue(found));
    setVirtualTraitsText(JSON.stringify(found.traits || {}, null, 2));
    setVirtualActionsText(serializeCapabilityActions(found.capabilities));
    if (found.model_template_id) setSelectedVirtualModelId(String(found.model_template_id));
  }, [selectedVirtualId, virtualConfig.devices]);

  useEffect(() => {
    if (!selectedVirtualModelEditId) return;
    const found = virtualModels.find((item) => item.id === selectedVirtualModelEditId);
    if (!found) return;
    setVirtualModelDraft(cloneValue(found));
    setVirtualModelTraitsText(JSON.stringify(found.traits || {}, null, 2));
    setVirtualModelActionsText(serializeCapabilityActions(found.capabilities));
  }, [selectedVirtualModelEditId, virtualModels]);

  const imageWidth = draft?.image?.width || imageDims?.width || 1000;
  const imageHeight = draft?.image?.height || imageDims?.height || 800;
  const availableCanvasWidth = canvasViewportSize.width || 1;
  const availableCanvasHeight = canvasViewportSize.height || 1;
  const fitScale = Math.min(availableCanvasWidth / imageWidth, availableCanvasHeight / imageHeight);
  const effectiveCanvasScale = Math.max(0.2, fitScale * canvasZoom);
  const canvasRenderWidth = Math.max(320, Math.round(imageWidth * effectiveCanvasScale));
  const canvasRenderHeight = Math.max(240, Math.round(imageHeight * effectiveCanvasScale));
  const effectiveShow3dPanel = pageStage === "editor" && (show3dPanel || mode === "calibration");
  const selectedRoom = draft?.rooms.find((room) => room.id === selectedRoomId) || null;
  const selectedPlacedDevice = draft?.devices.find((device) => device.deviceId === selectedDeviceId) || null;
  const selectedDevice = selectedPlacedDevice ? deviceMap[selectedPlacedDevice.deviceId] : null;
  const selectedDeviceLinks = getDeviceExternalLinks(selectedDevice);
  const availablePlacementDevices = draft ? devices.filter((device) => !draft.devices.some((item) => item.deviceId === device.id)) : devices;
  const availablePlacementDeviceIds = new Set(availablePlacementDevices.map((device) => device.id));
  const persistedImageScale = draft?.imageScale || null;
  const imageScaleMetrics = getImageScaleMetrics(persistedImageScale, imageWidth, imageHeight);
  const activeScalePoints = isSettingImageScale ? draftScalePoints : persistedImageScale?.points || [];
  const activeScaleMetrics =
    isSettingImageScale && draftScalePoints.length === 2
      ? getImageScaleMetrics({ points: [draftScalePoints[0], draftScalePoints[1]], distanceMeters: Number(scaleDistanceInput) || 0 }, imageWidth, imageHeight)
      : imageScaleMetrics;
  const selectedVirtualPlacementId = String(virtualDraft?.id || selectedVirtualId || "").trim();
  const isSelectedVirtualPersisted = Boolean(selectedVirtualPlacementId) && Boolean(devices.some((device) => device.id === selectedVirtualPlacementId));
  const isSelectedVirtualPlaced = Boolean(selectedVirtualPlacementId) && Boolean(draft?.devices.some((device) => device.deviceId === selectedVirtualPlacementId));
  const canPlaceSelectedVirtual = Boolean(selectedVirtualPlacementId) && availablePlacementDeviceIds.has(selectedVirtualPlacementId);
  const placingDeviceLabel = placingDeviceId
    ? deviceMap[placingDeviceId]?.name || (placingDeviceId === selectedVirtualPlacementId ? virtualDraft?.name || selectedVirtualId : "") || placingDeviceId
    : "";
  const selectedVirtualPlacementHint = !selectedVirtualPlacementId
    ? ""
    : isSelectedVirtualPlaced
      ? "已存在于当前户型图中。"
      : canPlaceSelectedVirtual
        ? "尚未布点。"
        : "还未保存到设备列表，保存后才能布点。";

  const updateDraft = (fn: (prev: Floorplan) => Floorplan) => {
    setDraft((prev) => (prev ? fn(prev) : prev));
  };

  const startPlacingDevice = (deviceId: string) => {
    const found = devices.find((device) => device.id === deviceId);
    if (!found) {
      setStatus(`未找到设备 ${deviceId}，请先保存设备并刷新列表`);
      return;
    }
    if (draft?.devices.some((device) => device.deviceId === deviceId)) {
      setPlacingDeviceId(null);
      setSelectedDeviceId(deviceId);
      setStatus(`${found.name || deviceId} 已经放置过了，请直接点击平面图中的设备点位调整位置`);
      return;
    }
    setSelectedDeviceId(null);
    setPlacingDeviceId(deviceId);
    setStatus(`已选中 ${found.name || deviceId}，请在 2D 户型图上点击要放置的位置`);
  };

  const handleSvgClick = (evt: ReactPointerEvent) => {
    if (!draft || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const point = toNormalizedPoint(evt, rect);

    if (mode === "view" && isSettingImageScale && draftScalePoints.length < 2) {
      setDraftScalePoints((prev) => [...prev, point]);
      return;
    }

    if (mode === "rooms" && isDrawingRoom) {
      setDraftRoomPoints((prev) => [...prev, point]);
      return;
    }

    if (mode === "calibration" && calibration.image.length < 3) {
      setCalibration((prev) => {
        const next = { ...prev, image: [...prev.image, point] };
        return next;
      });
      return;
    }

    if (mode === "devices" && placingDeviceId) {
      const placedDeviceId = placingDeviceId;
      updateDraft((prev) => {
        const roomId = findRoomForPoint(prev.rooms || [], point);
        return {
          ...prev,
          devices: [
            ...(prev.devices || []),
            {
              deviceId: placedDeviceId,
              x: point.x,
              y: point.y,
              height: 0,
              rotation: 0,
              scale: 1,
              roomId
            }
          ]
        };
      });
      setPlacingDeviceId(null);
      setSelectedDeviceId(placedDeviceId);
      setStatus("设备点位已添加，可在右侧继续调整高度、旋转和语义信息");
      return;
    }
  };

  const finishRoom = () => {
    if (!draft || draftRoomPoints.length < 3) return;
    const name = draftRoomName.trim() || `房间 ${draft.rooms.length + 1}`;
    const id = slugify(name);
    updateDraft((prev) => ({
      ...prev,
      rooms: [...prev.rooms, { id, name, polygon: draftRoomPoints }]
    }));
    setDraftRoomPoints([]);
    setDraftRoomName("");
    setIsDrawingRoom(false);
  };

  const undoDraftRoomPoint = () => {
    setDraftRoomPoints((prev) => prev.slice(0, -1));
  };

  const startImageScaleSelection = () => {
    if (!draft) return;
    setIsSettingImageScale(true);
    setDraftScalePoints([]);
    setScaleDistanceInput(draft.imageScale?.distanceMeters ? String(draft.imageScale.distanceMeters) : "");
    setStatus("请在 2D 户型图上依次点击比例尺的两个端点");
  };

  const undoImageScalePoint = () => {
    setDraftScalePoints((prev) => prev.slice(0, -1));
  };

  const cancelImageScaleSelection = () => {
    setIsSettingImageScale(false);
    setDraftScalePoints([]);
    setScaleDistanceInput(draft?.imageScale?.distanceMeters ? String(draft.imageScale.distanceMeters) : "");
  };

  const clearImageScale = () => {
    updateDraft((prev) => ({
      ...prev,
      imageScale: null
    }));
    setIsSettingImageScale(false);
    setDraftScalePoints([]);
    setScaleDistanceInput("");
    setStatus("比例尺已清除，请记得保存户型");
  };

  const saveImageScale = () => {
    if (!draft || draftScalePoints.length !== 2) {
      setStatus("请先在 2D 户型图上选择两个端点");
      return;
    }
    const distanceMeters = Number(scaleDistanceInput);
    if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
      setStatus("请输入有效的实际距离（米）");
      return;
    }
    const pixelDistance = getPointDistanceInPixels(draftScalePoints[0], draftScalePoints[1], imageWidth, imageHeight);
    if (!Number.isFinite(pixelDistance) || pixelDistance < 1) {
      setStatus("比例尺两点过近，请重新选择");
      return;
    }
    updateDraft((prev) => ({
      ...prev,
      imageScale: {
        points: [draftScalePoints[0], draftScalePoints[1]],
        distanceMeters
      }
    }));
    setIsSettingImageScale(false);
    setDraftScalePoints([]);
    setScaleDistanceInput(String(distanceMeters));
    setStatus("比例尺已更新，请保存户型");
  };

  const removeRoom = (roomId: string) => {
    updateDraft((prev) => ({
      ...prev,
      rooms: prev.rooms.filter((room) => room.id !== roomId),
      devices: prev.devices.map((device) => (device.roomId === roomId ? { ...device, roomId: "" } : device))
    }));
    setSelectedRoomId(null);
  };

  const removeDevice = (deviceId: string) => {
    updateDraft((prev) => ({
      ...prev,
      devices: prev.devices.filter((device) => device.deviceId !== deviceId)
    }));
    setSelectedDeviceId(null);
  };

  const resetCalibration = () => {
    setCalibration({ image: [], model: [] });
    updateDraft((prev) => ({ ...prev, modelTransform: null, calibrationPoints: null }));
  };

  const handlePick3dPoint = (point: Point3D) => {
    setCalibration((prev) => {
      if (prev.model.length >= 3) return prev;
      const next = { ...prev, model: [...prev.model, point] };
      return next;
    });
  };

  const uploadAsset = async (file: File, kind: "floorplan_image" | "floorplan_model") => {
    const form = new FormData();
    form.set("kind", kind);
    form.set("file", file);
    try {
      const res = await fetch("/api/assets", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.reason || data?.error || `upload_failed(${res.status})`);
      }
      return data as FloorplanAsset & { kind: string };
    } catch (err) {
      throw err;
    }
  };

  const saveFloorplan = async () => {
    if (!draft) return;
    setStatus("保存中...");
    try {
      const res = await fetch(`/api/floorplans/${encodeURIComponent(draft.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft)
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`保存失败: ${data?.reason || data?.error || res.status}`);
        return;
      }
      setDraft(data);
      setSavedSnapshot(JSON.stringify(data));
      setScaleDistanceInput(data?.imageScale?.distanceMeters ? String(data.imageScale.distanceMeters) : "");
      setFloorplans((prev) =>
        prev.map((plan) =>
          plan.id === data.id
            ? {
                ...plan,
                name: data.name,
                image: data.image,
                model: data.model,
                roomCount: data.rooms?.length ?? plan.roomCount,
                deviceCount: data.devices?.length ?? plan.deviceCount
              }
            : plan
        )
      );
      setStatus("已保存");
    } catch (err) {
      setStatus(`保存失败: ${(err as Error).message}`);
    }
  };

  const createFloorplan = async () => {
    if (!newPlanName.trim() || !newImageAsset) {
      if (newImageUploading) {
        setStatus("2D 图片上传中，请等待完成后再创建");
      } else if (newImageUploadError) {
        setStatus(`2D 图片未上传成功: ${newImageUploadError}`);
      } else {
        setStatus("需要名称与 2D 图片");
      }
      return;
    }
    const id = newPlanId.trim() || slugify(newPlanName);
    const payload: Floorplan = {
      id,
      name: newPlanName.trim(),
      image: newImageAsset,
      model: newModelAsset || undefined,
      rooms: [],
      devices: []
    };
    setStatus("创建中...");
    try {
      const res = await fetch("/api/floorplans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`创建失败: ${data?.reason || data?.error || res.status}`);
        return;
      }
      setNewPlanName("");
      setNewPlanId("");
      setNewImageAsset(null);
      setNewModelAsset(null);
      await refreshFloorplans();
      resetEditorTransientState();
      setActiveId(data.id);
      setPageStage("editor");
      setMode("view");
      setStatus("创建成功");
    } catch (err) {
      setStatus(`创建失败: ${(err as Error).message}`);
    }
  };

  const deleteFloorplan = async () => {
    if (!draft) return;
    if (!window.confirm(`确认删除户型 ${draft.name} (${draft.id})？`)) return;
    setStatus("删除中...");
    try {
      const res = await fetch(`/api/floorplans/${encodeURIComponent(draft.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(`删除失败: ${data?.reason || data?.error || res.status}`);
        return;
      }
      await refreshFloorplans();
      clearEditorState();
      setPageStage("browse");
      setBrowseView("select");
      setStatus("户型已删除");
    } catch (err) {
      setStatus(`删除失败: ${(err as Error).message}`);
    }
  };

  const zoomInCanvas = () => {
    setCanvasZoom((prev) => Math.min(prev + 0.25, 4));
  };

  const zoomOutCanvas = () => {
    setCanvasZoom((prev) => Math.max(prev - 0.25, 0.5));
  };

  const resetCanvasZoom = () => {
    setCanvasZoom(1);
  };

  const loadScenePreview = async (sceneId: string) => {
    if (!sceneId) {
      setScenePreview(null);
      setSceneEffects({});
      setSceneRunResult(null);
      return;
    }
    try {
      const res = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}/expanded`);
      const data = await res.json();
      if (!res.ok) {
        setStatus(`场景加载失败: ${data?.error || res.status}`);
        return;
      }
      const steps = (data.steps || []).filter((step: SceneStep) => step.type === "device");
      const preview = { sceneId, steps };
      setScenePreview(preview);
      setSceneEffects(buildSceneEffects(steps));
      setSceneRunResult(null);
    } catch (err) {
      setStatus(`场景加载失败: ${(err as Error).message}`);
    }
  };

  const executeScene = async () => {
    if (!scenePreview) return;
    const confirmed = window.confirm(`确认执行场景 ${scenePreview.sceneId}？`);
    if (!confirmed) return;
    setStatus("执行中...");
    setSceneRunLoading(true);
    try {
      const res = await fetch(`/api/scenes/${encodeURIComponent(scenePreview.sceneId)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, timeoutMs: 8000 })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(`场景执行失败: ${data?.reason || data?.error || res.status}`);
        setSceneRunResult(null);
        return;
      }
      setSceneRunResult(data);
      setStatus(`场景执行完成: ${data.status}`);
    } catch (err) {
      setStatus(`场景执行失败: ${(err as Error).message}`);
      setSceneRunResult(null);
    } finally {
      setSceneRunLoading(false);
    }
  };

  const startNewVirtualDevice = () => {
    const id = `sim_${Date.now()}`;
    const model = virtualModels.find((item) => item.id === selectedVirtualModelId);
    const next = buildVirtualDraftFromModel({
      id,
      defaults: virtualConfig.defaults,
      model: model || null
    });
    setSelectedVirtualId("");
    setVirtualDraft(next);
    setVirtualTraitsText(JSON.stringify(next.traits || {}, null, 2));
    setVirtualActionsText(serializeCapabilityActions(next.capabilities));
    setVirtualStatus("");
  };

  const startNewVirtualModel = () => {
    const id = `custom.model.${Date.now()}`;
    const next: VirtualDeviceModel = {
      id,
      name: "",
      protocol: "virtual",
      bindings: {},
      traits: { switch: { state: "off" } },
      capabilities: [{ action: "turn_on" }, { action: "turn_off" }],
      semantics: {}
    };
    setSelectedVirtualModelEditId("");
    setVirtualModelDraft(next);
    setVirtualModelTraitsText(JSON.stringify(next.traits || {}, null, 2));
    setVirtualModelActionsText(serializeCapabilityActions(next.capabilities));
    setVirtualModelStatus("");
  };

  const saveVirtualModel = async () => {
    if (!virtualModelDraft) return;
    const id = String(virtualModelDraft.id || "").trim();
    if (!id) {
      setVirtualModelStatus("型号模板 id 不能为空");
      return;
    }

    const parsedTraits = tryParseObject(virtualModelTraitsText);
    if (parsedTraits === null) {
      setVirtualModelStatus("型号模板 traits 必须是 JSON 对象");
      return;
    }

    const actions = virtualModelActionsText
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!actions.length) {
      setVirtualModelStatus("型号模板至少需要一个 capability action");
      return;
    }

    setVirtualModelSaving(true);
    setVirtualModelStatus("保存型号模板中...");
    try {
      const existingCaps = new Map(
        (Array.isArray(virtualModelDraft.capabilities) ? virtualModelDraft.capabilities : [])
          .filter((item) => item && item.action)
          .map((item) => [String(item.action), item])
      );
      const dedupActions = Array.from(new Set(actions));
      const payload: VirtualDeviceModel = {
        id,
        name: String(virtualModelDraft.name || id).trim() || id,
        category: String(virtualModelDraft.category || "").trim(),
        description: String(virtualModelDraft.description || "").trim(),
        placement: cloneValue(virtualModelDraft.placement || {}),
        protocol: String(virtualModelDraft.protocol || "virtual").trim() || "virtual",
        bindings: virtualModelDraft.bindings || {},
        traits: parsedTraits || {},
        capabilities: dedupActions.map((action) => {
          const existing = existingCaps.get(action);
          if (existing?.parameters) return { action, parameters: existing.parameters };
          return { action };
        }),
        semantics: virtualModelDraft.semantics || {},
        simulation: virtualModelDraft.simulation || {}
      };

      const resp = await fetch(`/api/virtual-devices/models/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setVirtualModelStatus(data?.reason || data?.error || "型号模板保存失败");
        return;
      }
      setVirtualModelDraft(data);
      setSelectedVirtualModelEditId(id);
      setSelectedVirtualModelId(id);
      await loadVirtualModels();
      setVirtualModelStatus("型号模板已保存");
    } catch (err) {
      setVirtualModelStatus((err as Error).message);
    } finally {
      setVirtualModelSaving(false);
    }
  };

  const deleteVirtualModel = async () => {
    const id = String(virtualModelDraft?.id || selectedVirtualModelEditId || "").trim();
    if (!id) return;
    if (!window.confirm(`确认删除型号模板 ${id}？`)) return;
    setVirtualModelSaving(true);
    setVirtualModelStatus("删除型号模板中...");
    try {
      const resp = await fetch(`/api/virtual-devices/models/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setVirtualModelStatus(data?.reason || data?.error || "型号模板删除失败");
        return;
      }
      setVirtualModelDraft(null);
      setSelectedVirtualModelEditId("");
      if (selectedVirtualModelId === id) {
        setSelectedVirtualModelId("");
      }
      await loadVirtualModels();
      setVirtualModelStatus("型号模板已删除");
    } catch (err) {
      setVirtualModelStatus((err as Error).message);
    } finally {
      setVirtualModelSaving(false);
    }
  };

  const saveVirtualDevice = async ({ placeAfterSave = false }: { placeAfterSave?: boolean } = {}) => {
    if (!virtualDraft) return;
    const id = String(virtualDraft.id || "").trim();
    if (!id) {
      setVirtualStatus("模拟设备 id 不能为空");
      return;
    }

    const parsedTraits = tryParseObject(virtualTraitsText);
    if (parsedTraits === null) {
      setVirtualStatus("traits 必须是 JSON 对象");
      return;
    }

    const actions = virtualActionsText
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!actions.length) {
      setVirtualStatus("至少需要一个 capability action");
      return;
    }

    setVirtualSaving(true);
    setVirtualStatus("保存中...");
    try {
      const existingCaps = new Map(
        (Array.isArray(virtualDraft.capabilities) ? virtualDraft.capabilities : [])
          .filter((item) => item && item.action)
          .map((item) => [String(item.action), item])
      );
      const dedupActions = Array.from(new Set(actions));
      const payload: VirtualDevice = {
        id,
        name: String(virtualDraft.name || id).trim() || id,
        model_template_id: String(virtualDraft.model_template_id || "").trim() || undefined,
        placement: {
          room: String(virtualDraft.placement?.room || "").trim(),
          zone: String(virtualDraft.placement?.zone || "").trim(),
          description: String(virtualDraft.placement?.description || "").trim()
        },
        protocol: String(virtualDraft.protocol || "virtual").trim() || "virtual",
        bindings: virtualDraft.bindings || {},
        traits: parsedTraits || {},
        capabilities: dedupActions.map((action) => {
          const existing = existingCaps.get(action);
          if (existing?.parameters) return { action, parameters: existing.parameters };
          return { action };
        }),
        semantics: virtualDraft.semantics || {},
        simulation: {
          latency_ms: Number(virtualDraft.simulation?.latency_ms ?? virtualConfig.defaults.latency_ms ?? 120),
          failure_rate: Number(virtualDraft.simulation?.failure_rate ?? virtualConfig.defaults.failure_rate ?? 0)
        }
      };

      const resp = await fetch(`/api/virtual-devices/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setVirtualStatus(data?.reason || data?.error || "保存失败");
        return;
      }
      setSelectedVirtualId(id);
      setVirtualDraft(data);
      await Promise.all([loadVirtualConfig(id), refreshDevices()]);
      if (placeAfterSave) {
        if (draft?.devices.some((device) => device.deviceId === id)) {
          setSelectedDeviceId(id);
          setPlacingDeviceId(null);
          setVirtualStatus("模拟设备已保存。该设备已在户型图中，右侧可直接编辑属性");
        } else {
          setSelectedDeviceId(null);
          setPlacingDeviceId(id);
          setStatus(`已保存模拟设备 ${String(data?.name || id)}，请在 2D 户型图上点击放置位置`);
          setVirtualStatus("模拟设备已保存并进入布点模式。下一步去中间 2D 户型图点击一次完成布点。");
        }
        return;
      }
      setVirtualStatus("模拟设备已保存。若要加到户型图，请点击“保存并去平面图布点”或左侧待放置设备清单");
    } catch (err) {
      setVirtualStatus((err as Error).message);
    } finally {
      setVirtualSaving(false);
    }
  };

  const deleteVirtualDevice = async () => {
    const id = String(virtualDraft?.id || selectedVirtualId || "").trim();
    if (!id) return;
    if (!window.confirm(`确认删除模拟设备 ${id}？`)) return;
    setVirtualSaving(true);
    setVirtualStatus("删除中...");
    try {
      const resp = await fetch(`/api/virtual-devices/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setVirtualStatus(data?.reason || data?.error || "删除失败");
        return;
      }
      setVirtualDraft(null);
      setSelectedVirtualId("");
      await Promise.all([loadVirtualConfig(""), refreshDevices()]);
      setVirtualStatus("模拟设备已删除");
    } catch (err) {
      setVirtualStatus((err as Error).message);
    } finally {
      setVirtualSaving(false);
    }
  };

  const saveVirtualGlobalConfig = async () => {
    setVirtualSaving(true);
    setVirtualStatus("保存全局配置中...");
    try {
      const resp = await fetch("/api/virtual-devices/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: virtualConfig.enabled,
          defaults: virtualConfig.defaults
        })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setVirtualStatus(data?.reason || data?.error || "保存失败");
        return;
      }
      setVirtualConfig({
        enabled: data?.enabled === true,
        defaults: data?.defaults || virtualConfig.defaults,
        devices: Array.isArray(data?.devices) ? data.devices : []
      });
      setVirtualStatus("模拟器全局配置已保存");
    } catch (err) {
      setVirtualStatus((err as Error).message);
    } finally {
      setVirtualSaving(false);
    }
  };

  const handlePointerMove = (evt: ReactPointerEvent) => {
    if (!draft || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const point = toNormalizedPoint(evt, rect);

    if (draggingDeviceRef.current) {
      updateDraft((prev) => ({
        ...prev,
        devices: prev.devices.map((device) => {
          if (device.deviceId !== draggingDeviceRef.current) return device;
          const roomId = findRoomForPoint(prev.rooms || [], point);
          return { ...device, x: point.x, y: point.y, roomId };
        })
      }));
      return;
    }

    if (draggingHandleRef.current) {
      const { roomId, index } = draggingHandleRef.current;
      updateDraft((prev) => ({
        ...prev,
        rooms: prev.rooms.map((room) => {
          if (room.id !== roomId) return room;
          const nextPolygon = [...room.polygon];
          nextPolygon[index] = point;
          return { ...room, polygon: nextPolygon };
        })
      }));
    }
  };

  const handlePointerUp = () => {
    draggingDeviceRef.current = null;
    draggingHandleRef.current = null;
  };

  const svgRoomPaths = draft?.rooms.map((room) => {
    const points = room.polygon.map((p) => `${p.x * imageWidth},${p.y * imageHeight}`).join(" ");
    return { room, points };
  });

  const svgDevices = draft?.devices.map((device) => {
    const effect = sceneEffects[device.deviceId];
    const label = effect?.label;
    const color = effect?.color || "#1f2937";
    return { device, color, label };
  });

  const renderScenePreviewPanel = () => (
    <div style={panelStyle}>
      <h3 style={panelTitleStyle}>场景预览</h3>
      <p style={{ ...hintStyle, marginBottom: 12 }}>先查看设备动作，再决定是否执行场景。</p>
      <select
        value={scenePreview?.sceneId || ""}
        onChange={(e) => loadScenePreview(e.target.value)}
        data-testid="scene-select"
        style={inputStyle}
      >
        <option value="">选择场景</option>
        {scenes.map((scene) => (
          <option key={scene.id} value={scene.id}>
            {scene.name}
          </option>
        ))}
      </select>
      {scenePreview && (
        <div style={{ marginTop: 12 }}>
          <p style={hintStyle}>共 {scenePreview.steps.length} 步设备动作</p>
          <button onClick={executeScene} style={primaryButtonStyle} disabled={sceneRunLoading} data-testid="scene-run">
            {sceneRunLoading ? "执行中..." : "执行场景"}
          </button>
          {sceneRunResult && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #e2e8f0" }}>
              <p style={hintStyle} data-testid="scene-run-status">
                run={sceneRunResult.runId} status={sceneRunResult.status} 耗时 {sceneRunResult.durationMs ?? 0}ms
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {sceneRunResult.steps.map((step) => (
                  <div
                    key={`${sceneRunResult.runId}-${step.index}`}
                    style={{
                      fontSize: 12,
                      border: "1px solid #e2e8f0",
                      borderRadius: 8,
                      padding: "6px 8px",
                      background:
                        step.status === "ok"
                          ? "#ecfdf5"
                          : step.status === "timeout"
                            ? "#eff6ff"
                            : step.status === "error"
                              ? "#fef2f2"
                              : "white"
                    }}
                  >
                    #{step.index + 1} {step.deviceId}.{step.action} 状态 {step.status}
                    {step.reason ? ` (${step.reason})` : ""}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const renderRoomInspector = () => (
    <div style={panelStyle}>
      <h3 style={panelTitleStyle}>房间属性</h3>
      {selectedRoom ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={labelStyle}>名称</label>
          <input
            value={selectedRoom.name}
            onChange={(e) =>
              updateDraft((prev) => ({
                ...prev,
                rooms: prev.rooms.map((room) => (room.id === selectedRoom.id ? { ...room, name: e.target.value } : room))
              }))
            }
            style={inputStyle}
          />
          <p style={hintStyle}>房间 ID：{selectedRoom.id}</p>
          <button onClick={() => removeRoom(selectedRoom.id)} style={dangerButtonStyle}>
            删除房间
          </button>
        </div>
      ) : (
        <p style={hintStyle}>先从左侧开始绘制房间，或点击平面图中已存在的房间来编辑名称。</p>
      )}
    </div>
  );

  const renderVirtualQuickSelector = () => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8
      }}
    >
      <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>步骤 1：选择设备型号 / 模拟设备</h4>
      <p style={hintStyle}>真实设备会直接出现在下面的待放置设备清单里；如果缺少设备，可以先在这里从型号模板创建一个模拟设备。</p>
      <div
        style={{
          padding: "12px 14px",
          borderRadius: 14,
          border: "1px solid #cbd5e1",
          background: "#f8fafc"
        }}
      >
        <p style={{ ...hintStyle, margin: 0 }}>操作顺序：1. 选型号模板 2. 新建或选择模拟设备 3. 保存并去平面图布点 4. 回到中间 2D 户型图点击一次完成布点。</p>
        {selectedVirtualPlacementId && (
          <p style={{ ...hintStyle, margin: "8px 0 0" }}>
            当前设备：{deviceMap[selectedVirtualPlacementId]?.name || virtualDraft?.name || selectedVirtualPlacementId}
            ，{selectedVirtualPlacementHint}
          </p>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
        <select
          value={selectedVirtualModelId}
          onChange={(e) => setSelectedVirtualModelId(e.target.value)}
          style={{ ...inputStyle, marginTop: 0, flex: "1 1 200px" }}
          data-testid="virtual-model-select"
        >
          <option value="">选择设备型号模板</option>
          {virtualModels.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({item.id})
            </option>
          ))}
        </select>
        <button type="button" style={secondaryButtonStyle} onClick={startNewVirtualDevice} data-testid="virtual-new">
          新建模拟设备
        </button>
      </div>

      <select
        value={selectedVirtualId}
        onChange={(e) => setSelectedVirtualId(e.target.value)}
        style={inputStyle}
        data-testid="virtual-select"
      >
        <option value="">选择已有模拟设备</option>
        {virtualConfig.devices.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name || item.id} ({item.id})
          </option>
        ))}
      </select>
    </div>
  );

  const renderVirtualDeviceManager = ({
    embedded = false,
    title = "模拟设备详情与高级配置",
    description = "需要修改模拟设备参数、保存并布点，或者维护模拟器全局配置与型号模板时，再展开下面这些内容。"
  }: {
    embedded?: boolean;
    title?: string;
    description?: string;
  } = {}) => (
    <div
      style={
        embedded
          ? {
              display: "flex",
              flexDirection: "column",
              gap: 8
            }
          : panelStyle
      }
    >
      {embedded ? <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{title}</h4> : <h3 style={panelTitleStyle}>{title}</h3>}
      <p style={hintStyle}>{description}</p>

      {virtualDraft && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8, paddingTop: 12, borderTop: "1px solid #e2e8f0" }}>
          <label style={labelStyle}>id</label>
          <input
            value={virtualDraft.id || ""}
            onChange={(e) => setVirtualDraft((prev) => ({ ...(prev || {}), id: e.target.value }))}
            style={inputStyle}
            data-testid="virtual-id"
          />
          <label style={labelStyle}>name</label>
          <input
            value={virtualDraft.name || ""}
            onChange={(e) => setVirtualDraft((prev) => ({ ...(prev || {}), name: e.target.value }))}
            style={inputStyle}
          />
          <label style={labelStyle}>placement.room</label>
          <input
            value={virtualDraft.placement?.room || ""}
            onChange={(e) =>
              setVirtualDraft((prev) => ({
                ...(prev || {}),
                placement: { ...(prev?.placement || {}), room: e.target.value }
              }))
            }
            style={inputStyle}
          />
          <label style={labelStyle}>placement.zone</label>
          <input
            value={virtualDraft.placement?.zone || ""}
            onChange={(e) =>
              setVirtualDraft((prev) => ({
                ...(prev || {}),
                placement: { ...(prev?.placement || {}), zone: e.target.value }
              }))
            }
            style={inputStyle}
          />
          <label style={labelStyle}>capabilities（逗号分隔）</label>
          <input
            value={virtualActionsText}
            onChange={(e) => setVirtualActionsText(e.target.value)}
            style={inputStyle}
            placeholder="turn_on, turn_off, set_brightness"
            data-testid="virtual-actions"
          />
          <label style={labelStyle}>traits(JSON)</label>
          <textarea
            value={virtualTraitsText}
            onChange={(e) => setVirtualTraitsText(e.target.value)}
            style={{ ...inputStyle, minHeight: 120, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
            data-testid="virtual-traits"
          />
          <label style={labelStyle}>simulation.latency_ms</label>
          <input
            type="number"
            min={0}
            value={virtualDraft.simulation?.latency_ms ?? virtualConfig.defaults.latency_ms}
            onChange={(e) =>
              setVirtualDraft((prev) => ({
                ...(prev || {}),
                simulation: { ...(prev?.simulation || {}), latency_ms: Number(e.target.value || 0) }
              }))
            }
            style={inputStyle}
          />
          <label style={labelStyle}>simulation.failure_rate</label>
          <input
            type="number"
            min={0}
            max={1}
            step="0.01"
            value={virtualDraft.simulation?.failure_rate ?? virtualConfig.defaults.failure_rate}
            onChange={(e) =>
              setVirtualDraft((prev) => ({
                ...(prev || {}),
                simulation: { ...(prev?.simulation || {}), failure_rate: Number(e.target.value || 0) }
              }))
            }
            style={inputStyle}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => saveVirtualDevice()}
              style={primaryButtonStyle}
              disabled={virtualSaving}
              data-testid="virtual-save"
            >
              {virtualSaving ? "保存中..." : "保存模拟设备"}
            </button>
            <button
              type="button"
              onClick={() => saveVirtualDevice({ placeAfterSave: true })}
              style={secondaryButtonStyle}
              disabled={virtualSaving}
              data-testid="virtual-save-and-place"
            >
              {virtualSaving ? "保存中..." : "保存并去平面图布点"}
            </button>
            <button
              type="button"
              onClick={() => startPlacingDevice(selectedVirtualPlacementId)}
              style={secondaryButtonStyle}
              disabled={!canPlaceSelectedVirtual || virtualSaving}
              data-testid="virtual-place"
            >
              将当前模拟设备放到户型图
            </button>
            <button
              type="button"
              onClick={deleteVirtualDevice}
              style={dangerButtonStyle}
              disabled={virtualSaving}
              data-testid="virtual-delete"
            >
              删除
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px dashed #e2e8f0" }}>
        <label style={labelStyle}>模拟器全局配置</label>
        <label style={labelStyle}>模拟器启用</label>
        <input
          type="checkbox"
          checked={virtualConfig.enabled}
          onChange={(e) => setVirtualConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
          data-testid="virtual-enabled"
        />

        <label style={labelStyle}>默认 latency_ms</label>
        <input
          type="number"
          min={0}
          value={virtualConfig.defaults.latency_ms}
          onChange={(e) =>
            setVirtualConfig((prev) => ({
              ...prev,
              defaults: { ...prev.defaults, latency_ms: Number(e.target.value || 0) }
            }))
          }
          style={inputStyle}
        />

        <label style={labelStyle}>默认 failure_rate (0~1)</label>
        <input
          type="number"
          min={0}
          max={1}
          step="0.01"
          value={virtualConfig.defaults.failure_rate}
          onChange={(e) =>
            setVirtualConfig((prev) => ({
              ...prev,
              defaults: { ...prev.defaults, failure_rate: Number(e.target.value || 0) }
            }))
          }
          style={inputStyle}
        />

        <button
          type="button"
          style={secondaryButtonStyle}
          onClick={saveVirtualGlobalConfig}
          disabled={virtualSaving}
          data-testid="virtual-save-global"
        >
          保存全局配置
        </button>
      </div>

      <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px dashed #e2e8f0" }}>
        <label style={labelStyle}>型号模板维护</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={secondaryButtonStyle} onClick={startNewVirtualModel} data-testid="virtual-model-new">
            新建型号模板
          </button>
          <select
            value={selectedVirtualModelEditId}
            onChange={(e) => setSelectedVirtualModelEditId(e.target.value)}
            style={{ ...inputStyle, marginTop: 0, flex: "1 1 200px" }}
            data-testid="virtual-model-edit-select"
          >
            <option value="">选择已有型号模板</option>
            {virtualModels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.id})
              </option>
            ))}
          </select>
        </div>

        {virtualModelDraft && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={labelStyle}>model.id</label>
            <input
              value={virtualModelDraft.id || ""}
              onChange={(e) => setVirtualModelDraft((prev) => (prev ? { ...prev, id: e.target.value } : prev))}
              style={inputStyle}
              data-testid="virtual-model-id"
            />
            <label style={labelStyle}>model.name</label>
            <input
              value={virtualModelDraft.name || ""}
              onChange={(e) => setVirtualModelDraft((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              style={inputStyle}
            />
            <label style={labelStyle}>model.category</label>
            <input
              value={virtualModelDraft.category || ""}
              onChange={(e) => setVirtualModelDraft((prev) => (prev ? { ...prev, category: e.target.value } : prev))}
              style={inputStyle}
            />
            <label style={labelStyle}>model.description</label>
            <textarea
              value={virtualModelDraft.description || ""}
              onChange={(e) => setVirtualModelDraft((prev) => (prev ? { ...prev, description: e.target.value } : prev))}
              style={{ ...inputStyle, minHeight: 72 }}
            />
            <label style={labelStyle}>model.capabilities（逗号分隔）</label>
            <input
              value={virtualModelActionsText}
              onChange={(e) => setVirtualModelActionsText(e.target.value)}
              style={inputStyle}
              placeholder="turn_on, turn_off, set_brightness"
              data-testid="virtual-model-actions"
            />
            <label style={labelStyle}>model.traits(JSON)</label>
            <textarea
              value={virtualModelTraitsText}
              onChange={(e) => setVirtualModelTraitsText(e.target.value)}
              style={{ ...inputStyle, minHeight: 120, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
              data-testid="virtual-model-traits"
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={saveVirtualModel}
                style={primaryButtonStyle}
                disabled={virtualModelSaving}
                data-testid="virtual-model-save"
              >
                {virtualModelSaving ? "保存中..." : "保存型号模板"}
              </button>
              <button
                type="button"
                onClick={deleteVirtualModel}
                style={dangerButtonStyle}
                disabled={virtualModelSaving}
                data-testid="virtual-model-delete"
              >
                删除型号模板
              </button>
            </div>
          </div>
        )}

        {virtualModelStatus && <p style={hintStyle}>{virtualModelStatus}</p>}
      </div>

      {virtualStatus && <p style={hintStyle}>{virtualStatus}</p>}
    </div>
  );

  const renderDeviceInspector = () => (
    <div style={panelStyle}>
      <h3 style={panelTitleStyle}>设备属性</h3>
      {selectedPlacedDevice ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ ...hintStyle, margin: 0 }}>
            当前选中：{deviceMap[selectedPlacedDevice.deviceId]?.name || selectedPlacedDevice.deviceId}。新布点成功后这里会自动切换到对应设备。
          </p>
          <label style={labelStyle}>高度 (m)</label>
          <input
            type="number"
            step="0.05"
            value={selectedPlacedDevice.height ?? 0}
            onChange={(e) =>
              updateDraft((prev) => ({
                ...prev,
                devices: prev.devices.map((device) =>
                  device.deviceId === selectedPlacedDevice.deviceId ? { ...device, height: Number(e.target.value) } : device
                )
              }))
            }
            style={inputStyle}
          />
          <label style={labelStyle}>旋转</label>
          <input
            type="number"
            step="1"
            value={selectedPlacedDevice.rotation ?? 0}
            onChange={(e) =>
              updateDraft((prev) => ({
                ...prev,
                devices: prev.devices.map((device) =>
                  device.deviceId === selectedPlacedDevice.deviceId ? { ...device, rotation: Number(e.target.value) } : device
                )
              }))
            }
            style={inputStyle}
          />
          <label style={labelStyle}>缩放</label>
          <input
            type="number"
            step="0.1"
            value={selectedPlacedDevice.scale ?? 1}
            onChange={(e) =>
              updateDraft((prev) => ({
                ...prev,
                devices: prev.devices.map((device) =>
                  device.deviceId === selectedPlacedDevice.deviceId ? { ...device, scale: Number(e.target.value) } : device
                )
              }))
            }
            style={inputStyle}
          />
          <button onClick={() => removeDevice(selectedPlacedDevice.deviceId)} style={dangerButtonStyle}>
            移除设备
          </button>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #e2e8f0" }}>
            <h4 style={{ margin: "0 0 8px 0", fontSize: 14 }}>外部系统入口</h4>
            <p style={hintStyle}>布点和空间属性继续在本平台维护；通用设备管理、历史和协议调试跳转到 HA / Zigbee2MQTT。</p>
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              {selectedDeviceLinks.haUrl ? (
                <a
                  href={selectedDeviceLinks.haUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={secondaryButtonStyle}
                  data-testid="floorplan-open-ha"
                >
                  Open in HA
                </a>
              ) : (
                <span style={{ ...secondaryButtonStyle, opacity: 0.6, cursor: "default" }}>HA 未绑定</span>
              )}
              {selectedDeviceLinks.zigbee2mqttUrl ? (
                <a
                  href={selectedDeviceLinks.zigbee2mqttUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={secondaryButtonStyle}
                  data-testid="floorplan-open-z2m"
                >
                  Open in Zigbee2MQTT
                </a>
              ) : (
                <span style={{ ...secondaryButtonStyle, opacity: 0.6, cursor: "default" }}>Z2M 未绑定</span>
              )}
            </div>
            <p style={{ ...hintStyle, marginTop: 10 }}>
              protocol={selectedDevice?.protocol || "unknown"}
              {selectedDevice?.placement?.room ? ` · room=${selectedDevice.placement.room}` : ""}
              {selectedDevice?.placement?.zone ? ` · zone=${selectedDevice.placement.zone}` : ""}
            </p>
          </div>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #e2e8f0" }}>
            <h4 style={{ margin: "0 0 8px 0", fontSize: 14 }}>设备元信息覆盖（devices.config.json）</h4>
            <p style={hintStyle}>用于覆盖 name / placement / semantics；保存后由 device-adapter 热更新（约 1~2 秒生效）。</p>

            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button
                onClick={() => router.push(`/scenes?deviceId=${encodeURIComponent(selectedPlacedDevice.deviceId)}`)}
                style={secondaryButtonStyle}
                type="button"
              >
                去场景编辑
              </button>
              <button
                onClick={() => router.push(`/automations?deviceId=${encodeURIComponent(selectedPlacedDevice.deviceId)}`)}
                style={secondaryButtonStyle}
                type="button"
              >
                去联动编辑
              </button>
            </div>

            <label style={labelStyle}>覆盖名称（name）</label>
            <input
              value={deviceOverrideDraft?.name || ""}
              onChange={(e) =>
                setDeviceOverrideDraft((prev: any) => ({
                  ...(prev || {}),
                  id: selectedPlacedDevice.deviceId,
                  name: e.target.value
                }))
              }
              style={inputStyle}
              placeholder={deviceMap[selectedPlacedDevice.deviceId]?.name || selectedPlacedDevice.deviceId}
            />

            <label style={labelStyle}>placement.room</label>
            <input
              value={deviceOverrideDraft?.placement?.room || ""}
              onChange={(e) =>
                setDeviceOverrideDraft((prev: any) => ({
                  ...(prev || {}),
                  id: selectedPlacedDevice.deviceId,
                  placement: { ...(prev?.placement || {}), room: e.target.value }
                }))
              }
              style={inputStyle}
              placeholder={deviceMap[selectedPlacedDevice.deviceId]?.placement?.room || ""}
            />

            <label style={labelStyle}>placement.zone</label>
            <input
              value={deviceOverrideDraft?.placement?.zone || ""}
              onChange={(e) =>
                setDeviceOverrideDraft((prev: any) => ({
                  ...(prev || {}),
                  id: selectedPlacedDevice.deviceId,
                  placement: { ...(prev?.placement || {}), zone: e.target.value }
                }))
              }
              style={inputStyle}
              placeholder={deviceMap[selectedPlacedDevice.deviceId]?.placement?.zone || ""}
            />

            <label style={labelStyle}>placement.description</label>
            <input
              value={deviceOverrideDraft?.placement?.description || ""}
              onChange={(e) =>
                setDeviceOverrideDraft((prev: any) => ({
                  ...(prev || {}),
                  id: selectedPlacedDevice.deviceId,
                  placement: { ...(prev?.placement || {}), description: e.target.value }
                }))
              }
              style={inputStyle}
              placeholder={deviceMap[selectedPlacedDevice.deviceId]?.placement?.description || ""}
            />

            <label style={labelStyle}>semantics.aliases（逗号分隔）</label>
            <input
              value={Array.isArray(deviceOverrideDraft?.semantics?.aliases) ? deviceOverrideDraft.semantics.aliases.join(", ") : ""}
              onChange={(e) => {
                const list = e.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean);
                setDeviceOverrideDraft((prev: any) => ({
                  ...(prev || {}),
                  id: selectedPlacedDevice.deviceId,
                  semantics: { ...(prev?.semantics || {}), aliases: list }
                }));
              }}
              style={inputStyle}
              placeholder="例如：主灯, 客厅主灯"
            />

            <label style={labelStyle}>semantics.tags（逗号分隔）</label>
            <input
              value={Array.isArray(deviceOverrideDraft?.semantics?.tags) ? deviceOverrideDraft.semantics.tags.join(", ") : ""}
              onChange={(e) => {
                const list = e.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean);
                setDeviceOverrideDraft((prev: any) => ({
                  ...(prev || {}),
                  id: selectedPlacedDevice.deviceId,
                  semantics: { ...(prev?.semantics || {}), tags: list }
                }));
              }}
              style={inputStyle}
              placeholder="例如：living_room, dimmable"
            />

            <label style={labelStyle}>semantics.preferred_scenes</label>
            <select
              multiple
              value={Array.isArray(deviceOverrideDraft?.semantics?.preferred_scenes) ? deviceOverrideDraft.semantics.preferred_scenes : []}
              onChange={(e) => {
                const selected = Array.from(e.target.selectedOptions).map((opt) => opt.value);
                setDeviceOverrideDraft((prev: any) => ({
                  ...(prev || {}),
                  id: selectedPlacedDevice.deviceId,
                  semantics: { ...(prev?.semantics || {}), preferred_scenes: selected }
                }));
              }}
              style={{ ...inputStyle, height: 110 }}
            >
              {scenes.map((scene) => (
                <option key={scene.id} value={scene.id}>
                  {scene.name} ({scene.id})
                </option>
              ))}
            </select>

            <button
              onClick={async () => {
                if (!selectedPlacedDevice.deviceId) return;
                setDeviceOverrideSaving(true);
                setDeviceOverrideStatus("保存中...");
                try {
                  const payload = {
                    id: selectedPlacedDevice.deviceId,
                    name: String(deviceOverrideDraft?.name || "").trim() || undefined,
                    placement: deviceOverrideDraft?.placement || undefined,
                    semantics: deviceOverrideDraft?.semantics || undefined
                  };
                  const resp = await fetch(`/api/device-overrides/${encodeURIComponent(selectedPlacedDevice.deviceId)}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                  });
                  const data = await resp.json().catch(() => ({}));
                  if (!resp.ok) {
                    setDeviceOverrideStatus(data?.reason || data?.error || "保存失败");
                    return;
                  }
                  setDeviceOverrideDraft(data);
                  setDeviceOverrideStatus("已保存（约 1~2 秒后生效）");
                } catch (err) {
                  setDeviceOverrideStatus((err as Error).message);
                } finally {
                  setDeviceOverrideSaving(false);
                }
              }}
              style={primaryButtonStyle}
              disabled={deviceOverrideSaving}
              type="button"
              data-testid="device-override-save"
            >
              {deviceOverrideSaving ? "保存中..." : "保存覆盖配置"}
            </button>

            {deviceOverrideStatus && <p style={hintStyle}>{deviceOverrideStatus}</p>}
          </div>
        </div>
      ) : (
        <p style={hintStyle}>先从左侧待放置设备里点一个设备，再到中间户型图点击布点；完成后这里会自动打开该设备的属性。</p>
      )}
    </div>
  );

  const renderCalibrationInspector = () => (
    <div style={panelStyle}>
      <h3 style={panelTitleStyle}>校准步骤</h3>
      <ol style={{ margin: "0 0 0 18px", padding: 0, color: "#334155", fontSize: 14, lineHeight: 1.7 }}>
        <li>先在 2D 户型图上点击 3 个位置清晰、尽量分散的点。</li>
        <li>再在 3D 模型里点击与之对应的 3 个点。</li>
        <li>校准完成后会生成 2D 到 3D 的映射，设备点位将出现在 3D 预览中。</li>
      </ol>
      <p style={{ ...hintStyle, marginTop: 12 }}>
        当前进度：2D 点 {calibration.image.length}/3，3D 点 {calibration.model.length}/3
      </p>
      <p style={hintStyle}>{draft?.modelTransform ? "已存在校准结果，可继续微调或重置。" : "尚未完成三点校准。"}</p>
      <button onClick={resetCalibration} style={secondaryButtonStyle}>
        重置校准
      </button>
    </div>
  );

  const renderFloorplanSummaryPanel = () => (
    <div style={panelStyle}>
      <h3 style={panelTitleStyle}>当前户型</h3>
      <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{draft?.name}</p>
      <p style={hintStyle}>ID：{draft?.id}</p>
      <p style={hintStyle}>
        房间 {draft?.rooms.length || 0} 个 · 设备 {draft?.devices.length || 0} 个 · {draft?.model?.url ? "已上传 3D 模型" : "仅 2D 户型图"}
      </p>
      <p style={hintStyle}>{draft?.imageScale ? `比例尺已设置：参考线 ${draft.imageScale.distanceMeters} 米` : "尚未设置 2D 比例尺"}</p>
      <p style={hintStyle}>{draft?.modelTransform ? "三点校准已完成" : "尚未完成三点校准"}</p>
    </div>
  );

  const renderEditorTools = () => {
    if (!draft) {
      return (
        <div style={panelStyle}>
          <h3 style={panelTitleStyle}>编辑工具</h3>
          <p style={hintStyle}>正在加载户型配置...</p>
        </div>
      );
    }

    if (mode === "devices") {
      return (
        <div className="floorplan-sticky" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {renderFloorplanSummaryPanel()}

          <div style={panelStyle}>
            <h3 style={panelTitleStyle}>添加设备</h3>
            <p style={hintStyle}>“添加设备”和“设备编辑”分开。先选择设备来源或型号，再从待放置设备清单里选一个设备，到中间 2D 户型图点击一次完成布点。</p>
            {renderVirtualQuickSelector()}

            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #e2e8f0", display: "flex", flexDirection: "column", gap: 10 }}>
              <label style={labelStyle}>步骤 2：选择待放置设备</label>
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: 16,
                  border: placingDeviceId ? "1px solid #2563eb" : "1px solid #cbd5e1",
                  background: placingDeviceId ? "rgba(219, 234, 254, 0.72)" : "#f8fafc"
                }}
                data-testid="placing-device-banner"
              >
                <p style={{ ...labelStyle, marginBottom: 6 }}>设备布点流程</p>
                <p style={{ ...hintStyle, margin: 0 }}>1. 先在下面点一个待放置设备。2. 再去中间 2D 户型图点击一次完成布点。3. 布点成功后右侧只显示该设备的属性编辑。</p>
                {placingDeviceId ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                    <strong style={{ fontSize: 14, color: "#0f172a" }}>当前待放置：{placingDeviceLabel}</strong>
                    <button
                      type="button"
                      onClick={() => setPlacingDeviceId(null)}
                      style={secondaryButtonStyle}
                      data-testid="cancel-device-placement"
                    >
                      取消布点
                    </button>
                  </div>
                ) : (
                  <p style={{ ...hintStyle, margin: "10px 0 0" }}>还没有选中待放置设备。点击下面任意一项后，画布会进入布点状态。</p>
                )}
              </div>

              <div>
                <label style={labelStyle}>待放置设备</label>
                <p style={hintStyle}>真实设备和已经保存的模拟设备都会出现在这里。点击后再去中间户型图上落点。</p>
                <p style={hintStyle} data-testid="placement-device-summary">
                  当前已布点 {draft.devices.length} 个，待布点 {availablePlacementDevices.length} 个
                </p>
                {selectedVirtualPlacementId && !isSelectedVirtualPersisted && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: "12px 14px",
                      borderRadius: 14,
                      border: "1px solid #fdba74",
                      background: "#fff7ed",
                      display: "flex",
                      flexDirection: "column",
                      gap: 10
                    }}
                    data-testid="pending-virtual-placement-card"
                  >
                    <p style={{ ...hintStyle, margin: 0, color: "#9a3412" }}>
                      当前模拟设备 {virtualDraft?.name || selectedVirtualPlacementId} 还没加入待放置设备列表，所以这里暂时看不到它。先保存后，它就会出现在下面。
                    </p>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        onClick={() => saveVirtualDevice()}
                        style={secondaryButtonStyle}
                        disabled={virtualSaving || !virtualDraft}
                        data-testid="virtual-save-to-placement"
                      >
                        {virtualSaving ? "保存中..." : "保存到待放置列表"}
                      </button>
                      <button
                        type="button"
                        onClick={() => saveVirtualDevice({ placeAfterSave: true })}
                        style={primaryButtonStyle}
                        disabled={virtualSaving || !virtualDraft}
                        data-testid="virtual-save-to-placement-and-place"
                      >
                        {virtualSaving ? "保存中..." : "保存并立即布点"}
                      </button>
                    </div>
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                  {availablePlacementDevices.map((device) => (
                    <button
                      key={device.id}
                      type="button"
                      onClick={() => startPlacingDevice(device.id)}
                      style={{
                        ...secondaryButtonStyle,
                        width: "100%",
                        textAlign: "left",
                        borderColor: device.id === placingDeviceId ? "#2563eb" : "#cbd5e1",
                        background: device.id === placingDeviceId ? "#eff6ff" : "white"
                      }}
                      data-testid={`start-place-${device.id}`}
                    >
                      <span style={{ display: "block", fontWeight: 700, color: "#0f172a" }}>{device.name || device.id}</span>
                      <span style={{ display: "block", marginTop: 4, fontSize: 12, color: "#64748b" }}>
                        {device.id}
                        {device.placement?.room ? ` · room=${device.placement.room}` : ""}
                        {device.placement?.zone ? ` · zone=${device.placement.zone}` : ""}
                      </span>
                    </button>
                  ))}
                  {!availablePlacementDevices.length && (
                    <p style={hintStyle} data-testid="placement-empty">
                      当前所有已知设备都已布点。若还需要补充设备，请先在上方创建模拟设备，然后点击“保存并去平面图布点”。
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #e2e8f0" }}>
              {renderVirtualDeviceManager({
                embedded: true,
                title: "步骤 3：编辑当前模拟设备 / 高级配置",
                description: "只有在需要修改模拟设备参数、保存并布点、或者维护型号模板时，才需要继续操作下面这些内容。"
              })}
            </div>
          </div>

          <div style={panelStyle}>
            <h3 style={panelTitleStyle}>设备编辑</h3>
            <p style={hintStyle}>已放置设备会出现在这里。点击某个设备后，右侧只显示它的属性编辑；添加新设备请回到上面的“添加设备”。</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {draft.devices.map((device) => (
                <button
                  key={device.deviceId}
                  type="button"
                  onClick={() => setSelectedDeviceId(device.deviceId)}
                  style={{
                    ...secondaryButtonStyle,
                    width: "100%",
                    textAlign: "left",
                    borderColor: device.deviceId === selectedDeviceId ? "#0f172a" : "#cbd5e1",
                    background: device.deviceId === selectedDeviceId ? "#f8fafc" : "white"
                  }}
                >
                  {deviceMap[device.deviceId]?.name || device.deviceId}
                </button>
              ))}
              {!draft.devices.length && <p style={hintStyle}>还没有设备点位，先在上面的“添加设备”里选一个设备并在 2D 图中点击放置。</p>}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="floorplan-sticky" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {renderFloorplanSummaryPanel()}

        <div style={panelStyle}>
          <h3 style={panelTitleStyle}>编辑工具</h3>
          <p style={hintStyle}>当前模式：{MODE_LABELS[mode]}</p>

          {mode === "view" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={hintStyle}>先浏览平面图与设备布点，需要看 3D 时再展开预览或切换到校准模式。</p>
              <p style={hintStyle}>
                {draft.imageScale
                  ? activeScaleMetrics
                    ? `当前比例尺 ${draft.imageScale.distanceMeters} 米，约 1 米 = ${activeScaleMetrics.pixelsPerMeter.toFixed(1)} 像素`
                    : `当前比例尺 ${draft.imageScale.distanceMeters} 米`
                  : "建议上传底图后先设置比例尺，再继续做房间、设备和校准。"}
              </p>
              <button type="button" style={secondaryButtonStyle} onClick={() => setShow3dPanel((prev) => !prev)}>
                {effectiveShow3dPanel ? "收起 3D 预览" : "打开 3D 预览"}
              </button>
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={startImageScaleSelection}
                data-testid="start-image-scale"
              >
                {draft.imageScale ? "重新设置比例尺" : "开始设置比例尺"}
              </button>

              {isSettingImageScale && (
                <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 12 }}>
                  <p style={hintStyle} data-testid="scale-point-count">
                    取点进度：{draftScalePoints.length}/2
                  </p>
                  <label style={labelStyle}>实际距离（米）</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={scaleDistanceInput}
                    onChange={(e) => setScaleDistanceInput(e.target.value)}
                    style={inputStyle}
                    placeholder="例如：3.5"
                    data-testid="image-scale-distance"
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={saveImageScale}
                      style={primaryButtonStyle}
                      disabled={draftScalePoints.length !== 2}
                      data-testid="image-scale-save"
                    >
                      保存比例尺
                    </button>
                    <button
                      type="button"
                      onClick={undoImageScalePoint}
                      style={secondaryButtonStyle}
                      disabled={!draftScalePoints.length}
                      data-testid="undo-image-scale-point"
                    >
                      撤销上一步
                    </button>
                    <button type="button" onClick={cancelImageScaleSelection} style={secondaryButtonStyle}>
                      取消
                    </button>
                  </div>
                  <p style={hintStyle}>请在户型图上依次点击两点，并输入这段线在真实房间中的长度。</p>
                </div>
              )}
            </div>
          )}

          {mode === "rooms" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                style={secondaryButtonStyle}
                type="button"
                onClick={() => {
                  setDraftRoomPoints([]);
                  setDraftRoomName("");
                  setSelectedRoomId(null);
                  setIsDrawingRoom(true);
                }}
                data-testid="start-room-drawing"
              >
                {isDrawingRoom ? "继续绘制房间" : "开始绘制房间"}
              </button>
              {isDrawingRoom && (
                <div>
                  <label style={labelStyle}>房间名称</label>
                  <input value={draftRoomName} onChange={(e) => setDraftRoomName(e.target.value)} style={inputStyle} />
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button
                      onClick={undoDraftRoomPoint}
                      style={secondaryButtonStyle}
                      type="button"
                      disabled={!draftRoomPoints.length}
                      data-testid="undo-room-point"
                    >
                      撤销上一步
                    </button>
                    <button onClick={finishRoom} style={primaryButtonStyle} type="button">
                      完成房间
                    </button>
                    <button
                      onClick={() => {
                        setDraftRoomPoints([]);
                        setDraftRoomName("");
                        setIsDrawingRoom(false);
                      }}
                      style={secondaryButtonStyle}
                      type="button"
                    >
                      取消
                    </button>
                  </div>
                  <p style={hintStyle} data-testid="room-point-count">
                    已选择 {draftRoomPoints.length} 个点，请在平面图上连续点击至少 3 个点，完成后保存房间。
                  </p>
                </div>
              )}

              <div style={{ marginTop: 4 }}>
                <label style={labelStyle}>已定义房间</label>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                  {draft.rooms.map((room) => (
                    <button
                      key={room.id}
                      type="button"
                      onClick={() => setSelectedRoomId(room.id)}
                      style={{
                        ...secondaryButtonStyle,
                        width: "100%",
                        textAlign: "left",
                        borderColor: room.id === selectedRoomId ? "#0f172a" : "#cbd5e1",
                        background: room.id === selectedRoomId ? "#f8fafc" : "white"
                      }}
                    >
                      {room.name}
                    </button>
                  ))}
                  {!draft.rooms.length && <p style={hintStyle}>还没有房间，先开始绘制一个区域。</p>}
                </div>
              </div>
            </div>
          )}

          {mode === "calibration" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={hintStyle}>校准时会自动打开 3D 预览。建议先在 2D 中选角点，再去 3D 中选对应点。</p>
              <p style={hintStyle}>当前进度：2D 点 {calibration.image.length}/3，3D 点 {calibration.model.length}/3</p>
              <button onClick={resetCalibration} style={secondaryButtonStyle} type="button">
                重置校准
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderContextPanels = () => {
    if (!draft) {
      return (
        <div style={panelStyle}>
          <h3 style={panelTitleStyle}>上下文面板</h3>
          <p style={hintStyle}>正在加载当前户型内容...</p>
        </div>
      );
    }

    return (
      <div className="floorplan-sticky" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {mode === "view" && (
          <>
            <div style={panelStyle}>
              <h3 style={panelTitleStyle}>查看信息</h3>
              <p style={hintStyle}>当前户型只展示与预览相关的内容；房间、设备、校准入口都在顶部模式切换中。</p>
              <p style={hintStyle}>
                图片分辨率：{draft.image.width || imageDims?.width || "-"} × {draft.image.height || imageDims?.height || "-"}
              </p>
              <p style={hintStyle}>
                {persistedImageScale
                  ? `比例尺参考线 ${persistedImageScale.distanceMeters} 米`
                  : "尚未设置比例尺，真实距离相关能力暂时无法建立统一长度基准。"}
              </p>
              {imageScaleMetrics && (
                <p style={hintStyle}>
                  估算换算：1 米约等于 {imageScaleMetrics.pixelsPerMeter.toFixed(1)} 像素，每像素约 {imageScaleMetrics.metersPerPixel.toFixed(4)} 米
                </p>
              )}
              <p style={hintStyle}>{draft.model?.url ? "已挂载 3D 模型，可随时展开预览。" : "尚未上传 3D 模型。"}</p>
              {persistedImageScale && !isSettingImageScale && (
                <button type="button" onClick={clearImageScale} style={dangerButtonStyle} data-testid="clear-image-scale">
                  清除比例尺
                </button>
              )}
            </div>
            {renderScenePreviewPanel()}
          </>
        )}
        {mode === "rooms" && renderRoomInspector()}
        {mode === "devices" && renderDeviceInspector()}
        {mode === "calibration" && renderCalibrationInspector()}
      </div>
    );
  };

  const renderBrowseStage = () => (
    <section data-testid="floorplan-stage-browse" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ ...panelStyle, background: "rgba(255,255,255,0.92)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18 }}>先选择入口，再进入编辑</h3>
            <p style={{ margin: "6px 0 0", color: "#475569" }}>选择已有户型或新建一个新的户型；进入编辑后只保留与当前户型相关的工具。</p>
          </div>
          <div style={{ display: "flex", gap: 10 }} data-testid="floorplan-entry-tabs">
            <button
              type="button"
              onClick={() => setBrowseView("select")}
              style={{
                ...secondaryButtonStyle,
                borderColor: browseView === "select" ? "#0f172a" : "#cbd5e1",
                background: browseView === "select" ? "#0f172a" : "white",
                color: browseView === "select" ? "white" : "#0f172a"
              }}
              data-testid="browse-select"
            >
              选择户型
            </button>
            <button
              type="button"
              onClick={() => setBrowseView("create")}
              style={{
                ...secondaryButtonStyle,
                borderColor: browseView === "create" ? "#0f172a" : "#cbd5e1",
                background: browseView === "create" ? "#0f172a" : "white",
                color: browseView === "create" ? "white" : "#0f172a"
              }}
              data-testid="browse-create"
            >
              新建户型
            </button>
          </div>
        </div>
      </div>

      <div className="floorplan-browse-grid">
        {browseView === "select" ? (
          <div style={panelStyle}>
            <h3 style={panelTitleStyle}>户型列表</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="floorplan-list">
              {floorplans.map((plan) => (
                <div
                  key={plan.id}
                  style={{
                    border: "1px solid #dbe4ea",
                    borderRadius: 16,
                    overflow: "hidden",
                    background: "#fffdf9",
                    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)"
                  }}
                >
                  <div style={{ height: 180, background: "#f8fafc", borderBottom: "1px solid #e2e8f0", display: "grid", placeItems: "center" }}>
                    {plan.image?.url ? (
                      <img
                        src={resolveAssetUrl(plan.image.url)}
                        alt={plan.name}
                        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                      />
                    ) : (
                      <span style={{ color: "#94a3b8", fontSize: 13 }}>暂无预览图</span>
                    )}
                  </div>
                  <div style={{ padding: 16 }}>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>{plan.name}</div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{plan.id}</div>
                    <div style={{ fontSize: 12, color: "#475569", marginTop: 10 }}>
                      房间 {plan.roomCount ?? 0} 个 · 设备 {plan.deviceCount ?? 0} 个 · {plan.model?.url ? "含 3D" : "仅 2D"}
                    </div>
                    <button
                      type="button"
                      onClick={() => enterEditor(plan.id)}
                      style={{ ...primaryButtonStyle, width: "100%" }}
                      data-testid={`select-floorplan-${plan.id}`}
                    >
                      进入编辑
                    </button>
                  </div>
                </div>
              ))}
              {!floorplans.length && <p style={hintStyle}>还没有任何户型，切换到“新建户型”开始上传底图。</p>}
            </div>
          </div>
        ) : (
          <div style={panelStyle} data-testid="create-floorplan-form">
            <h3 style={panelTitleStyle}>新建户型</h3>
            <label style={labelStyle}>名称</label>
            <input value={newPlanName} onChange={(e) => setNewPlanName(e.target.value)} placeholder="例如：一层" style={inputStyle} />
            <label style={labelStyle}>ID（可选）</label>
            <input value={newPlanId} onChange={(e) => setNewPlanId(e.target.value)} placeholder="floor1" style={inputStyle} />
            <label style={labelStyle}>上传 2D 户型图（PNG/JPG）</label>
            <input
              type="file"
              accept="image/png,image/jpeg"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setNewImageUploadError("");
                setNewImageAsset(null);
                setNewImageUploading(true);
                setStatus("2D 图片上传中...");
                try {
                  const asset = await uploadAsset(file, "floorplan_image");
                  setNewImageAsset(asset);
                  setStatus("2D 图片上传成功");
                } catch (err) {
                  const message = (err as Error).message;
                  setNewImageUploadError(message);
                  setStatus(`上传失败: ${message}`);
                } finally {
                  setNewImageUploading(false);
                }
              }}
            />
            {newImageUploading && <p style={hintStyle}>2D 图片上传中...</p>}
            {newImageUploadError && !newImageUploading && <p style={{ ...hintStyle, color: "#b91c1c" }}>2D 上传失败：{newImageUploadError}</p>}
            {newImageAsset && !newImageUploading && <p style={hintStyle}>已上传：{newImageAsset.url}</p>}

            <label style={labelStyle}>上传 3D 模型（GLB，可选）</label>
            <input
              type="file"
              accept=".glb,model/gltf-binary"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setNewModelUploadError("");
                setNewModelAsset(null);
                setNewModelUploading(true);
                setStatus("3D 模型上传中...");
                try {
                  const asset = await uploadAsset(file, "floorplan_model");
                  setNewModelAsset(asset);
                  setStatus("3D 模型上传成功");
                } catch (err) {
                  const message = (err as Error).message;
                  setNewModelUploadError(message);
                  setStatus(`上传失败: ${message}`);
                } finally {
                  setNewModelUploading(false);
                }
              }}
            />
            {newModelUploading && <p style={hintStyle}>3D 模型上传中...</p>}
            {newModelUploadError && !newModelUploading && <p style={{ ...hintStyle, color: "#b91c1c" }}>3D 上传失败：{newModelUploadError}</p>}
            {newModelAsset && !newModelUploading && <p style={hintStyle}>已上传：{newModelAsset.url}</p>}

            <button onClick={createFloorplan} style={primaryButtonStyle} disabled={newImageUploading || newModelUploading}>
              {newImageUploading || newModelUploading ? "上传中..." : "创建户型并进入编辑"}
            </button>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={panelStyle}>
            <h3 style={panelTitleStyle}>工作流说明</h3>
            <p style={hintStyle}>1. 先选择已有户型，或者新建并上传底图。</p>
            <p style={hintStyle}>2. 进入编辑后，顶部切换“视图 / 房间编辑 / 设备编辑 / 校准”。</p>
            <p style={hintStyle}>3. 左侧只显示当前模式的工具，中间是可滚动的 2D 画布，右侧显示当前选中对象的属性。</p>
          </div>
          <div style={panelStyle}>
            <h3 style={panelTitleStyle}>当前概况</h3>
            <p style={hintStyle}>已保存户型：{floorplans.length} 个</p>
            <p style={hintStyle}>优先推荐先完成 2D 房间与设备布点，再进行三点校准。</p>
          </div>
        </div>
      </div>
    </section>
  );

  return (
    <>
      <Head>
        <title>户型编辑与 3D 预览</title>
      </Head>
      <Script
        id="three-importmap"
        type="importmap"
        strategy="beforeInteractive"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({ imports: { three: "/vendor/three/three.module.js" } })
        }}
      />
      <main
        style={{
          minHeight: "100vh",
          background: pageBg,
          fontFamily: '"Space Grotesk", "Avenir Next", "Noto Sans", sans-serif',
          color: "#0f172a",
          padding: "24px"
        }}
        data-testid="floorplan-page"
      >
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: "20px", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "24px", letterSpacing: "-0.02em" }}>户型编辑与 3D 预览</h1>
            <p style={{ margin: "6px 0 0", color: "#475569" }}>
              {pageStage === "browse" ? "先选择或新建户型，再进入 2D 编辑、设备布点和三点校准。" : "2D 编辑优先，3D 预览在需要时展开。"}
            </p>
          </div>

          {pageStage === "editor" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end", flex: "1 1 640px" }} data-testid="floorplan-stage-editor">
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button type="button" onClick={returnToBrowse} style={secondaryButtonStyle} data-testid="back-to-browser">
                  返回户型选择
                </button>
                <button type="button" onClick={() => replaceImageInputRef.current?.click()} style={secondaryButtonStyle}>
                  替换底图
                </button>
                <button type="button" onClick={() => replaceModelInputRef.current?.click()} style={secondaryButtonStyle}>
                  替换 3D
                </button>
                <button type="button" onClick={() => setShow3dPanel((prev) => !prev)} style={secondaryButtonStyle}>
                  {effectiveShow3dPanel ? "收起 3D" : "展开 3D"}
                </button>
                <button onClick={saveFloorplan} style={primaryButtonStyle} data-testid="save-floorplan" disabled={!isDirty}>
                  {isDirty ? "保存户型" : "已保存"}
                </button>
                <button type="button" onClick={deleteFloorplan} style={dangerButtonStyle} data-testid="delete-floorplan">
                  删除户型
                </button>
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                {Object.entries(MODE_LABELS).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setMode(key as Mode)}
                    data-testid={`mode-${key}`}
                    style={{
                      padding: "8px 12px",
                      borderRadius: "999px",
                      border: "1px solid #cbd5f5",
                      background: mode === key ? "#0f172a" : "white",
                      color: mode === key ? "white" : "#0f172a",
                      fontWeight: 600,
                      cursor: "pointer"
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <input
                ref={replaceImageInputRef}
                type="file"
                accept="image/png,image/jpeg"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file || !draft) return;
                  try {
                    const asset = await uploadAsset(file, "floorplan_image");
                    updateDraft((prev) => ({
                      ...prev,
                      image: asset,
                      modelTransform: null,
                      calibrationPoints: null,
                      imageScale: null
                    }));
                    setCalibration({ image: [], model: [] });
                    setIsSettingImageScale(false);
                    setDraftScalePoints([]);
                    setScaleDistanceInput("");
                    setCanvasZoom(1);
                    setStatus("底图已替换，比例尺与校准结果已清空，请重新设置");
                  } catch (err) {
                    setStatus(`上传失败: ${(err as Error).message}`);
                  } finally {
                    e.currentTarget.value = "";
                  }
                }}
              />

              <input
                ref={replaceModelInputRef}
                type="file"
                accept=".glb,model/gltf-binary"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file || !draft) return;
                  try {
                    const asset = await uploadAsset(file, "floorplan_model");
                    updateDraft((prev) => ({
                      ...prev,
                      model: asset,
                      modelTransform: null,
                      calibrationPoints: null
                    }));
                    setCalibration({ image: [], model: [] });
                    setStatus("3D 模型已替换，请重新完成三点校准");
                  } catch (err) {
                    setStatus(`上传失败: ${(err as Error).message}`);
                  } finally {
                    e.currentTarget.value = "";
                  }
                }}
              />
            </div>
          )}
        </header>

        {pageStage === "browse" ? (
          renderBrowseStage()
        ) : (
          <section className="floorplan-editor-grid">
            <aside className="floorplan-sidebar">{renderEditorTools()}</aside>

            <section className="floorplan-editor-main" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ ...panelStyle, padding: 0, overflow: "hidden" }}>
                <div style={panelHeaderStyle}>
                  <div>
                    <h3 style={{ margin: 0 }}>2D 编辑工作区</h3>
                    <p style={{ ...hintStyle, marginTop: 4 }}>
                      {mode === "rooms"
                        ? isDrawingRoom
                          ? "正在绘制房间：在底图上连续点击至少 3 个点。"
                          : "点击左侧开始绘制，或直接点选已有房间。"
                        : mode === "devices"
                          ? placingDeviceId
                            ? `待放置设备：${placingDeviceLabel}。下一次点击 2D 户型图会创建点位，并自动打开右侧属性。`
                            : "先在左侧点一个待放置设备，再到 2D 户型图点击完成布点；点击已放置设备可编辑，拖动设备点位可调整位置。"
                          : mode === "calibration"
                            ? "先在 2D 选 3 个点，再到 3D 选对应的 3 个点。"
                            : "默认按图片比例自适应显示，可手动放大后滚动查看细节。"}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" onClick={zoomOutCanvas} style={secondaryButtonStyle} data-testid="canvas-zoom-out">
                      缩小
                    </button>
                    <button type="button" onClick={resetCanvasZoom} style={secondaryButtonStyle} data-testid="canvas-zoom-reset">
                      适配窗口
                    </button>
                    <button type="button" onClick={zoomInCanvas} style={secondaryButtonStyle} data-testid="canvas-zoom-in">
                      放大
                    </button>
                  </div>
                </div>

                {draft ? (
                  <div
                    ref={canvasViewportRef}
                    data-testid="canvas-scroll-region"
                    style={{
                      position: "relative",
                      height: "clamp(420px, 68vh, 760px)",
                      overflow: "auto",
                      padding: 20,
                      background:
                        "radial-gradient(circle at top left, rgba(226, 232, 240, 0.75), rgba(248, 250, 252, 0.92) 38%, rgba(241, 245, 249, 0.95) 100%)"
                    }}
                  >
                    <div style={{ minWidth: "100%", minHeight: "100%", display: "grid", placeItems: "center" }}>
                      <div
                        style={{
                          width: canvasRenderWidth,
                          height: canvasRenderHeight,
                          borderRadius: 18,
                          overflow: "hidden",
                          boxShadow: "0 16px 34px rgba(15, 23, 42, 0.16)",
                          background: "white"
                        }}
                      >
                        <svg
                          ref={svgRef}
                          viewBox={`0 0 ${imageWidth} ${imageHeight}`}
                          preserveAspectRatio="xMidYMid meet"
                          style={{
                            width: canvasRenderWidth,
                            height: canvasRenderHeight,
                            display: "block",
                            cursor:
                              mode === "devices"
                                ? placingDeviceId
                                  ? "crosshair"
                                  : "grab"
                                : mode === "rooms" && isDrawingRoom
                                  ? "crosshair"
                                  : mode === "calibration"
                                    ? "crosshair"
                                    : "default"
                          }}
                          onPointerDown={(evt) => handleSvgClick(evt)}
                          onPointerMove={handlePointerMove}
                          onPointerUp={handlePointerUp}
                          data-testid="floorplan-canvas"
                        >
                          <image href={resolveAssetUrl(draft.image.url)} width={imageWidth} height={imageHeight} />
                          {activeScalePoints.length === 2 && (
                            <g>
                              <line
                                x1={activeScalePoints[0].x * imageWidth}
                                y1={activeScalePoints[0].y * imageHeight}
                                x2={activeScalePoints[1].x * imageWidth}
                                y2={activeScalePoints[1].y * imageHeight}
                                stroke={isSettingImageScale ? "#f97316" : "#2563eb"}
                                strokeWidth={3}
                                strokeDasharray={isSettingImageScale ? "8 6" : "10 4"}
                              />
                              <rect
                                x={((activeScalePoints[0].x + activeScalePoints[1].x) / 2) * imageWidth - 42}
                                y={((activeScalePoints[0].y + activeScalePoints[1].y) / 2) * imageHeight - 22}
                                width={84}
                                height={20}
                                rx={10}
                                fill="rgba(15, 23, 42, 0.86)"
                              />
                              <text
                                x={((activeScalePoints[0].x + activeScalePoints[1].x) / 2) * imageWidth}
                                y={((activeScalePoints[0].y + activeScalePoints[1].y) / 2) * imageHeight - 8}
                                fontSize="11"
                                fill="white"
                                textAnchor="middle"
                              >
                                {(isSettingImageScale ? Number(scaleDistanceInput) || 0 : persistedImageScale?.distanceMeters || 0) > 0
                                  ? `${(isSettingImageScale ? Number(scaleDistanceInput) || 0 : persistedImageScale?.distanceMeters || 0).toFixed(2)}m`
                                  : "比例尺"}
                              </text>
                            </g>
                          )}
                          {activeScalePoints.map((point, idx) => (
                            <circle
                              key={`scale-point-${idx}`}
                              cx={point.x * imageWidth}
                              cy={point.y * imageHeight}
                              r={6}
                              fill={isSettingImageScale ? "#f97316" : "#2563eb"}
                              stroke="white"
                              strokeWidth={2}
                            />
                          ))}
                          {svgRoomPaths?.map(({ room, points }) => (
                            <g key={room.id}>
                              <polygon
                                points={points}
                                fill={room.id === selectedRoomId ? "rgba(14, 116, 144, 0.2)" : "rgba(14, 116, 144, 0.12)"}
                                stroke={room.id === selectedRoomId ? "#0e7490" : "#0ea5a4"}
                                strokeWidth={2}
                                onPointerDown={(evt) => {
                                  if (mode !== "rooms") return;
                                  evt.stopPropagation();
                                  setSelectedRoomId(room.id);
                                }}
                              />
                              <text x={room.polygon[0].x * imageWidth + 6} y={room.polygon[0].y * imageHeight + 16} fontSize="12" fill="#0f172a">
                                {room.name}
                              </text>
                              {mode === "rooms" &&
                                room.polygon.map((point, idx) => (
                                  <circle
                                    key={`${room.id}-${idx}`}
                                    cx={point.x * imageWidth}
                                    cy={point.y * imageHeight}
                                    r={5}
                                    fill="#0f172a"
                                    onPointerDown={(evt) => {
                                      evt.stopPropagation();
                                      draggingHandleRef.current = { roomId: room.id, index: idx };
                                    }}
                                  />
                                ))}
                            </g>
                          ))}
                          {draftRoomPoints.length > 0 && (
                            <polyline
                              points={draftRoomPoints.map((point) => `${point.x * imageWidth},${point.y * imageHeight}`).join(" ")}
                              fill="none"
                              stroke="#f97316"
                              strokeWidth={2}
                            />
                          )}
                          {svgDevices?.map(({ device, color, label }) => (
                            <g key={device.deviceId}>
                              <circle
                                cx={device.x * imageWidth}
                                cy={device.y * imageHeight}
                                r={8}
                                fill={color}
                                stroke={device.deviceId === selectedDeviceId ? "#0f172a" : "white"}
                                strokeWidth={2}
                                data-testid={`floorplan-device-${device.deviceId}`}
                                onPointerDown={(evt) => {
                                  evt.stopPropagation();
                                  if (mode === "devices") {
                                    draggingDeviceRef.current = device.deviceId;
                                  }
                                  setSelectedDeviceId(device.deviceId);
                                }}
                              />
                              <text x={device.x * imageWidth + 12} y={device.y * imageHeight - 6} fontSize="12" fill="#0f172a">
                                {deviceMap[device.deviceId]?.name || device.deviceId}
                              </text>
                              {label && (
                                <text x={device.x * imageWidth + 12} y={device.y * imageHeight + 10} fontSize="11" fill="#64748b">
                                  {label}
                                </text>
                              )}
                            </g>
                          ))}
                          {mode === "calibration" &&
                            calibration.image.map((point, idx) => (
                              <circle key={`calib-${idx}`} cx={point.x * imageWidth} cy={point.y * imageHeight} r={6} fill="#f97316" />
                            ))}
                        </svg>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: 20 }}>正在加载户型...</div>
                )}
              </div>

              {effectiveShow3dPanel && (
                <div style={{ ...panelStyle, padding: 0, overflow: "hidden" }}>
                  <div style={panelHeaderStyle}>
                    <div>
                      <h3 style={{ margin: 0 }}>3D 预览</h3>
                      <p style={{ ...hintStyle, marginTop: 4 }}>校准模式下会在 3D 模型里拾取点位；其他模式仅用于辅助核对空间关系。</p>
                    </div>
                    {mode !== "calibration" && (
                      <button type="button" onClick={() => setShow3dPanel(false)} style={secondaryButtonStyle}>
                        收起
                      </button>
                    )}
                  </div>
                  {draft?.model?.url ? (
                    <div style={{ height: 320 }}>
                      <ThreePreview
                        modelUrl={resolveAssetUrl(draft.model.url)}
                        transform={draft.modelTransform}
                        devices={draft.devices}
                        calibrationPoints={calibration}
                        mode={mode}
                        sceneEffects={sceneEffects}
                        onPickPoint={handlePick3dPoint}
                        selectedDeviceId={selectedDeviceId}
                      />
                    </div>
                  ) : (
                    <div style={{ padding: 20 }}>暂无 3D 模型，请先在顶部上传 GLB 文件。</div>
                  )}
                </div>
              )}
            </section>

            <aside className="floorplan-sidebar">{renderContextPanels()}</aside>
          </section>
        )}

        {status && (
          <div style={{ marginTop: "16px", padding: "12px 16px", borderRadius: "12px", background: "#0f172a", color: "white" }}>
            {status}
          </div>
        )}

        <style jsx>{`
          .floorplan-browse-grid {
            display: grid;
            gap: 20px;
            grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
            align-items: start;
          }

          .floorplan-editor-grid {
            display: grid;
            gap: 20px;
            grid-template-columns: minmax(240px, 280px) minmax(0, 1fr) minmax(300px, 360px);
            align-items: start;
          }

          .floorplan-editor-main,
          .floorplan-sidebar {
            min-width: 0;
          }

          .floorplan-sticky {
            position: sticky;
            top: 24px;
            max-height: calc(100vh - 48px);
            overflow: auto;
          }

          @media (max-width: 1180px) {
            .floorplan-browse-grid,
            .floorplan-editor-grid {
              grid-template-columns: 1fr;
            }

            .floorplan-sticky {
              position: static;
              max-height: none;
              overflow: visible;
            }
          }
        `}</style>
      </main>
    </>
  );
}

const panelStyle: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.85)",
  border: "1px solid #e2e8f0",
  borderRadius: "16px",
  padding: "16px",
  boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)"
};

const panelHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "12px 16px",
  borderBottom: "1px solid #e2e8f0",
  background: "rgba(255, 255, 255, 0.9)"
};

const panelTitleStyle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: "16px",
  fontWeight: 700
};

const labelStyle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  color: "#475569",
  marginTop: "10px"
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: "10px",
  border: "1px solid #cbd5f5",
  marginTop: "6px"
};

const primaryButtonStyle: React.CSSProperties = {
  marginTop: "12px",
  padding: "8px 12px",
  borderRadius: "10px",
  border: "none",
  background: "#0f172a",
  color: "white",
  fontWeight: 600,
  cursor: "pointer"
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: "10px",
  border: "1px solid #0f172a",
  background: "white",
  color: "#0f172a",
  fontWeight: 600,
  cursor: "pointer"
};

const dangerButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: "10px",
  border: "1px solid #ef4444",
  background: "#fee2e2",
  color: "#b91c1c",
  fontWeight: 600,
  cursor: "pointer"
};

const hintStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "#64748b",
  margin: "6px 0 0"
};
