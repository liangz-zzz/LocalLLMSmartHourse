import Head from "next/head";
import Script from "next/script";
import { useRouter } from "next/router";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

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

type Device = {
  id: string;
  name: string;
  placement?: { room?: string; zone?: string; description?: string };
  traits?: Record<string, any>;
  capabilities?: { action: string; parameters?: any[] }[];
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

  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingDeviceRef = useRef<string | null>(null);
  const draggingHandleRef = useRef<{ roomId: string; index: number } | null>(null);

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

  const refreshDevices = async () => {
    const res = await fetch("/api/devices");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.reason || data?.error || "加载设备失败");
    setDevices(data.items || []);
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

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/floorplans");
        const data = await res.json();
        const items = data.items || [];
        setFloorplans(items);
        if (!activeId && items.length) {
          setActiveId(items[0].id);
        }
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
    loadScenes();
  }, []);

  useEffect(() => {
    if (!activeId) return;
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
        setDraftRoomPoints([]);
        setIsDrawingRoom(false);
        setSelectedRoomId(null);
        setSelectedDeviceId(null);
        setScenePreview(null);
        setSceneEffects({});
        setSceneRunResult(null);
      } catch (err) {
        setStatus(`加载户型失败: ${(err as Error).message}`);
      }
    };
    loadFloorplan();
  }, [activeId]);

  useEffect(() => {
    if (!draft?.image?.url) return;
    const img = new Image();
    img.onload = () => {
      setImageDims({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = resolveAssetUrl(draft.image.url);
  }, [draft?.image?.url]);

  useEffect(() => {
    if (mode !== "view") return;
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
        if (active && mode === "view") setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      active = false;
      ws?.close();
    };
  }, [mode]);

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
    setVirtualDraft(JSON.parse(JSON.stringify(found)));
    setVirtualTraitsText(JSON.stringify(found.traits || {}, null, 2));
    setVirtualActionsText(
      Array.isArray(found.capabilities) && found.capabilities.length
        ? found.capabilities.map((item) => item.action).filter(Boolean).join(", ")
        : "turn_on, turn_off"
    );
  }, [selectedVirtualId, virtualConfig.devices]);

  const imageWidth = draft?.image?.width || imageDims?.width || 1000;
  const imageHeight = draft?.image?.height || imageDims?.height || 800;

  const updateDraft = (fn: (prev: Floorplan) => Floorplan) => {
    setDraft((prev) => (prev ? fn(prev) : prev));
  };

  const handleSvgClick = (evt: ReactPointerEvent) => {
    if (!draft || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const point = toNormalizedPoint(evt, rect);

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
      updateDraft((prev) => {
        const roomId = findRoomForPoint(prev.rooms || [], point);
        return {
          ...prev,
          devices: [
            ...(prev.devices || []),
            {
              deviceId: placingDeviceId,
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
    const res = await fetch("/api/assets", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.reason || data?.error || "upload_failed");
    }
    return data as FloorplanAsset & { kind: string };
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
      setStatus("需要名称与 2D 图片");
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
      const listRes = await fetch("/api/floorplans");
      const listData = await listRes.json();
      setFloorplans(listData.items || []);
      setActiveId(data.id);
      setStatus("创建成功");
    } catch (err) {
      setStatus(`创建失败: ${(err as Error).message}`);
    }
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
    const next: VirtualDevice = {
      id,
      name: "",
      placement: { room: "living_room", zone: "" },
      protocol: "virtual",
      bindings: {},
      traits: { switch: { state: "off" } },
      capabilities: [{ action: "turn_on" }, { action: "turn_off" }],
      simulation: {
        latency_ms: Number(virtualConfig.defaults.latency_ms || 120),
        failure_rate: Number(virtualConfig.defaults.failure_rate || 0)
      }
    };
    setSelectedVirtualId("");
    setVirtualDraft(next);
    setVirtualTraitsText(JSON.stringify(next.traits || {}, null, 2));
    setVirtualActionsText("turn_on, turn_off");
    setVirtualStatus("");
  };

  const saveVirtualDevice = async () => {
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
      const payload: VirtualDevice = {
        id,
        name: String(virtualDraft.name || id).trim() || id,
        placement: {
          room: String(virtualDraft.placement?.room || "").trim(),
          zone: String(virtualDraft.placement?.zone || "").trim(),
          description: String(virtualDraft.placement?.description || "").trim()
        },
        protocol: String(virtualDraft.protocol || "virtual").trim() || "virtual",
        bindings: virtualDraft.bindings || {},
        traits: parsedTraits || {},
        capabilities: actions.map((action) => ({ action })),
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
      setVirtualStatus("模拟设备已保存");
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
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "24px", letterSpacing: "-0.02em" }}>户型编辑与 3D 预览</h1>
            <p style={{ margin: "6px 0 0", color: "#475569" }}>2D 编辑 + 三点校准 + 3D 预览</p>
          </div>
          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
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
        </header>

        <section style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: "20px" }}>
          <aside style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={panelStyle}>
              <h3 style={panelTitleStyle}>户型列表</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }} data-testid="floorplan-list">
                {floorplans.map((plan) => (
                  <button
                    key={plan.id}
                    onClick={() => setActiveId(plan.id)}
                    style={{
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: "10px",
                      border: plan.id === activeId ? "1px solid #0f172a" : "1px solid #e2e8f0",
                      background: plan.id === activeId ? "#0f172a" : "white",
                      color: plan.id === activeId ? "white" : "#0f172a",
                      cursor: "pointer"
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{plan.name}</div>
                    <div style={{ fontSize: "12px", opacity: 0.7 }}>{plan.id}</div>
                  </button>
                ))}
                {!floorplans.length && <p style={{ margin: 0, color: "#94a3b8" }}>暂无户型</p>}
              </div>
            </div>

            <div style={panelStyle}>
              <h3 style={panelTitleStyle}>新建户型</h3>
              <label style={labelStyle}>名称</label>
              <input
                value={newPlanName}
                onChange={(e) => setNewPlanName(e.target.value)}
                placeholder="例如：一层"
                style={inputStyle}
              />
              <label style={labelStyle}>ID（可选）</label>
              <input
                value={newPlanId}
                onChange={(e) => setNewPlanId(e.target.value)}
                placeholder="floor1"
                style={inputStyle}
              />
              <label style={labelStyle}>上传 2D 户型图（PNG/JPG）</label>
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const asset = await uploadAsset(file, "floorplan_image");
                    setNewImageAsset(asset);
                  } catch (err) {
                    setStatus(`上传失败: ${(err as Error).message}`);
                  }
                }}
              />
              {newImageAsset && <p style={hintStyle}>已上传：{newImageAsset.url}</p>}
              <label style={labelStyle}>上传 3D 模型（GLB，可选）</label>
              <input
                type="file"
                accept=".glb,model/gltf-binary"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const asset = await uploadAsset(file, "floorplan_model");
                    setNewModelAsset(asset);
                  } catch (err) {
                    setStatus(`上传失败: ${(err as Error).message}`);
                  }
                }}
              />
              {newModelAsset && <p style={hintStyle}>已上传：{newModelAsset.url}</p>}
              <button onClick={createFloorplan} style={primaryButtonStyle}>
                创建户型
              </button>
            </div>

            <div style={panelStyle}>
              <h3 style={panelTitleStyle}>场景预览</h3>
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
                <div style={{ marginTop: "8px" }}>
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

            {draft && (
              <div style={panelStyle}>
                <h3 style={panelTitleStyle}>编辑</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <label style={labelStyle}>名称</label>
                  <input
                    value={draft.name}
                    onChange={(e) =>
                      updateDraft((prev) => ({
                        ...prev,
                        name: e.target.value
                      }))
                    }
                    style={inputStyle}
                  />
                  <p style={hintStyle}>ID：{draft.id}</p>
                  <button onClick={saveFloorplan} style={primaryButtonStyle} data-testid="save-floorplan" disabled={!isDirty}>
                    {isDirty ? "保存户型" : "已保存"}
                  </button>
                  <p style={hintStyle}>当前模式：{MODE_LABELS[mode]}</p>
                  {mode === "rooms" && (
                    <>
                      <button
                        style={secondaryButtonStyle}
                        onClick={() => {
                          setDraftRoomPoints([]);
                          setDraftRoomName("");
                          setIsDrawingRoom(true);
                        }}
                      >
                        新建房间
                      </button>
                      {isDrawingRoom && (
                        <div>
                          <label style={labelStyle}>房间名称</label>
                          <input value={draftRoomName} onChange={(e) => setDraftRoomName(e.target.value)} style={inputStyle} />
                          <button onClick={finishRoom} style={primaryButtonStyle}>
                            完成房间
                          </button>
                        </div>
                      )}
                    </>
                  )}
                  {mode === "devices" && (
                    <>
                      <label style={labelStyle}>选择设备</label>
                      <select
                        value={placingDeviceId || ""}
                        onChange={(e) => setPlacingDeviceId(e.target.value || null)}
                        style={inputStyle}
                      >
                        <option value="">点击后在图上放置</option>
                        {devices
                          .filter((device) => !draft.devices.some((d) => d.deviceId === device.id))
                          .map((device) => (
                            <option key={device.id} value={device.id}>
                              {device.name} ({device.id})
                            </option>
                          ))}
                      </select>
                      {placingDeviceId && <p style={hintStyle}>在 2D 图上点击放置设备</p>}

                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #e2e8f0" }}>
                        <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>模拟设备</h4>
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

                        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                          <button type="button" style={secondaryButtonStyle} onClick={startNewVirtualDevice} data-testid="virtual-new">
                            新建模拟设备
                          </button>
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

                        {virtualDraft && (
                          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
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
                            <div style={{ display: "flex", gap: 8 }}>
                              <button
                                type="button"
                                onClick={saveVirtualDevice}
                                style={primaryButtonStyle}
                                disabled={virtualSaving}
                                data-testid="virtual-save"
                              >
                                {virtualSaving ? "保存中..." : "保存模拟设备"}
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

                        {virtualStatus && <p style={hintStyle}>{virtualStatus}</p>}
                      </div>
                    </>
                  )}
                  {mode === "calibration" && (
                    <>
                      <p style={hintStyle}>2D 点 {calibration.image.length}/3，3D 点 {calibration.model.length}/3</p>
                      <button onClick={resetCalibration} style={secondaryButtonStyle}>
                        重置校准
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {selectedRoomId && draft && mode === "rooms" && (
              <div style={panelStyle}>
                <h3 style={panelTitleStyle}>房间设置</h3>
                {draft.rooms
                  .filter((room) => room.id === selectedRoomId)
                  .map((room) => (
                    <div key={room.id} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <label style={labelStyle}>名称</label>
                      <input
                        value={room.name}
                        onChange={(e) =>
                          updateDraft((prev) => ({
                            ...prev,
                            rooms: prev.rooms.map((r) => (r.id === room.id ? { ...r, name: e.target.value } : r))
                          }))
                        }
                        style={inputStyle}
                      />
                      <button onClick={() => removeRoom(room.id)} style={dangerButtonStyle}>
                        删除房间
                      </button>
                    </div>
                  ))}
              </div>
            )}

            {selectedDeviceId && draft && mode === "devices" && (
              <div style={panelStyle}>
                <h3 style={panelTitleStyle}>设备设置</h3>
                {draft.devices
                  .filter((device) => device.deviceId === selectedDeviceId)
                  .map((device) => (
                    <div key={device.deviceId} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <label style={labelStyle}>高度 (m)</label>
                      <input
                        type="number"
                        step="0.05"
                        value={device.height ?? 0}
                        onChange={(e) =>
                          updateDraft((prev) => ({
                            ...prev,
                            devices: prev.devices.map((d) =>
                              d.deviceId === device.deviceId ? { ...d, height: Number(e.target.value) } : d
                            )
                          }))
                        }
                        style={inputStyle}
                      />
                      <label style={labelStyle}>旋转</label>
                      <input
                        type="number"
                        step="1"
                        value={device.rotation ?? 0}
                        onChange={(e) =>
                          updateDraft((prev) => ({
                            ...prev,
                            devices: prev.devices.map((d) =>
                              d.deviceId === device.deviceId ? { ...d, rotation: Number(e.target.value) } : d
                            )
                          }))
                        }
                        style={inputStyle}
                      />
                      <label style={labelStyle}>缩放</label>
                      <input
                        type="number"
                        step="0.1"
                        value={device.scale ?? 1}
                        onChange={(e) =>
                          updateDraft((prev) => ({
                            ...prev,
                            devices: prev.devices.map((d) =>
                              d.deviceId === device.deviceId ? { ...d, scale: Number(e.target.value) } : d
                            )
                          }))
                        }
                        style={inputStyle}
                      />
                      <button onClick={() => removeDevice(device.deviceId)} style={dangerButtonStyle}>
                        移除设备
                      </button>

                      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #e2e8f0" }}>
                        <h4 style={{ margin: "0 0 8px 0", fontSize: 14 }}>设备元信息覆盖（devices.config.json）</h4>
                        <p style={hintStyle}>用于覆盖 name / placement / semantics；保存后由 device-adapter 热更新（约 1~2 秒生效）。</p>

                        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                          <button
                            onClick={() => router.push(`/scenes?deviceId=${encodeURIComponent(device.deviceId)}`)}
                            style={secondaryButtonStyle}
                            type="button"
                          >
                            去场景编辑
                          </button>
                          <button
                            onClick={() => router.push(`/automations?deviceId=${encodeURIComponent(device.deviceId)}`)}
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
                              id: device.deviceId,
                              name: e.target.value
                            }))
                          }
                          style={inputStyle}
                          placeholder={deviceMap[device.deviceId]?.name || device.deviceId}
                        />

                        <label style={labelStyle}>placement.room</label>
                        <input
                          value={deviceOverrideDraft?.placement?.room || ""}
                          onChange={(e) =>
                            setDeviceOverrideDraft((prev: any) => ({
                              ...(prev || {}),
                              id: device.deviceId,
                              placement: { ...(prev?.placement || {}), room: e.target.value }
                            }))
                          }
                          style={inputStyle}
                          placeholder={deviceMap[device.deviceId]?.placement?.room || ""}
                        />

                        <label style={labelStyle}>placement.zone</label>
                        <input
                          value={deviceOverrideDraft?.placement?.zone || ""}
                          onChange={(e) =>
                            setDeviceOverrideDraft((prev: any) => ({
                              ...(prev || {}),
                              id: device.deviceId,
                              placement: { ...(prev?.placement || {}), zone: e.target.value }
                            }))
                          }
                          style={inputStyle}
                          placeholder={deviceMap[device.deviceId]?.placement?.zone || ""}
                        />

                        <label style={labelStyle}>placement.description</label>
                        <input
                          value={deviceOverrideDraft?.placement?.description || ""}
                          onChange={(e) =>
                            setDeviceOverrideDraft((prev: any) => ({
                              ...(prev || {}),
                              id: device.deviceId,
                              placement: { ...(prev?.placement || {}), description: e.target.value }
                            }))
                          }
                          style={inputStyle}
                          placeholder={deviceMap[device.deviceId]?.placement?.description || ""}
                        />

                        <label style={labelStyle}>semantics.aliases（逗号分隔）</label>
                        <input
                          value={Array.isArray(deviceOverrideDraft?.semantics?.aliases) ? deviceOverrideDraft.semantics.aliases.join(", ") : ""}
                          onChange={(e) => {
                            const list = e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean);
                            setDeviceOverrideDraft((prev: any) => ({
                              ...(prev || {}),
                              id: device.deviceId,
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
                              .map((s) => s.trim())
                              .filter(Boolean);
                            setDeviceOverrideDraft((prev: any) => ({
                              ...(prev || {}),
                              id: device.deviceId,
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
                              id: device.deviceId,
                              semantics: { ...(prev?.semantics || {}), preferred_scenes: selected }
                            }));
                          }}
                          style={{ ...inputStyle, height: 110 }}
                        >
                          {scenes.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} ({s.id})
                            </option>
                          ))}
                        </select>

                        <button
                          onClick={async () => {
                            if (!device.deviceId) return;
                            setDeviceOverrideSaving(true);
                            setDeviceOverrideStatus("保存中...");
                            try {
                              const payload = {
                                id: device.deviceId,
                                name: String(deviceOverrideDraft?.name || "").trim() || undefined,
                                placement: deviceOverrideDraft?.placement || undefined,
                                semantics: deviceOverrideDraft?.semantics || undefined
                              };
                              const resp = await fetch(`/api/device-overrides/${encodeURIComponent(device.deviceId)}`, {
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
                  ))}
              </div>
            )}
          </aside>

          <section style={{ display: "grid", gridTemplateRows: "1fr 1fr", gap: "16px", height: "calc(100vh - 140px)" }}>
            <div style={{ ...panelStyle, padding: 0, overflow: "hidden" }}>
              <div style={panelHeaderStyle}>
                <h3 style={{ margin: 0 }}>2D 编辑</h3>
                {draft && (
                  <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <button
                      style={secondaryButtonStyle}
                      onClick={() => {
                        const fileInput = document.getElementById("replace-image") as HTMLInputElement | null;
                        fileInput?.click();
                      }}
                    >
                      替换图片
                    </button>
                    <input
                      id="replace-image"
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
                            calibrationPoints: null
                          }));
                          setCalibration({ image: [], model: [] });
                        } catch (err) {
                          setStatus(`上传失败: ${(err as Error).message}`);
                        }
                      }}
                    />
                  </div>
                )}
              </div>
              {draft ? (
                <div style={{ position: "relative", width: "100%", height: "100%" }}>
                  <svg
                    ref={svgRef}
                    viewBox={`0 0 ${imageWidth} ${imageHeight}`}
                    preserveAspectRatio="xMidYMid meet"
                    style={{ width: "100%", height: "100%", cursor: mode === "devices" ? "crosshair" : "default" }}
                    onPointerDown={(evt) => handleSvgClick(evt)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    data-testid="floorplan-canvas"
                  >
                    <image href={resolveAssetUrl(draft.image.url)} width={imageWidth} height={imageHeight} />
                    {svgRoomPaths?.map(({ room, points }) => (
                      <g key={room.id}>
                        <polygon
                          points={points}
                          fill={room.id === selectedRoomId ? "rgba(14, 116, 144, 0.2)" : "rgba(14, 116, 144, 0.12)"}
                          stroke={room.id === selectedRoomId ? "#0e7490" : "#0ea5a4"}
                          strokeWidth={2}
                          onPointerDown={(evt) => {
                            evt.stopPropagation();
                            if (mode === "rooms") setSelectedRoomId(room.id);
                          }}
                        />
                        <text
                          x={room.polygon[0].x * imageWidth + 6}
                          y={room.polygon[0].y * imageHeight + 16}
                          fontSize="12"
                          fill="#0f172a"
                        >
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
                        points={draftRoomPoints.map((p) => `${p.x * imageWidth},${p.y * imageHeight}`).join(" ")}
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
                        <circle
                          key={`calib-${idx}`}
                          cx={point.x * imageWidth}
                          cy={point.y * imageHeight}
                          r={6}
                          fill="#f97316"
                        />
                      ))}
                  </svg>
                </div>
              ) : (
                <div style={{ padding: "20px" }}>请先创建或选择户型。</div>
              )}
            </div>

            <div style={{ ...panelStyle, padding: 0, overflow: "hidden" }}>
              <div style={panelHeaderStyle}>
                <h3 style={{ margin: 0 }}>3D 预览</h3>
                {draft && (
                  <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <button
                      style={secondaryButtonStyle}
                      onClick={() => {
                        const fileInput = document.getElementById("replace-model") as HTMLInputElement | null;
                        fileInput?.click();
                      }}
                    >
                      替换模型
                    </button>
                    <input
                      id="replace-model"
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
                        } catch (err) {
                          setStatus(`上传失败: ${(err as Error).message}`);
                        }
                      }}
                    />
                  </div>
                )}
              </div>
              {draft?.model?.url ? (
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
              ) : (
                <div style={{ padding: "20px" }}>暂无 3D 模型。</div>
              )}
            </div>
          </section>
        </section>

        {status && (
          <div style={{ marginTop: "16px", padding: "12px 16px", borderRadius: "12px", background: "#0f172a", color: "white" }}>
            {status}
          </div>
        )}
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
