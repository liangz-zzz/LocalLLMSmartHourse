import Head from "next/head";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type { Device } from "../lib/device-types";
import type { Floorplan, FloorplanSummary } from "../lib/floorplan-context";
import { getStoredFloorplanId, resolveInitialFloorplanId, setStoredFloorplanId } from "../lib/floorplan-context";
import { getDeviceExternalLinks, useIntegrationBases } from "../lib/integrations";

type ChatTurn = { role: "user" | "assistant"; content: string };

type IntentResult = {
  action: string;
  deviceId?: string;
  params?: Record<string, any>;
  confidence?: number;
  summary?: string;
};

type SceneSummary = {
  id: string;
  name: string;
  description?: string;
  scope?: { floorplanIds?: string[] };
};

const pageBg = "linear-gradient(135deg, #09121d 0%, #18324a 42%, #0f6a6c 100%)";

const panelStyle: CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  borderRadius: 18,
  border: "1px solid rgba(255,255,255,0.08)",
  padding: "1rem"
};

const linkButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.65rem 0.9rem",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.08)",
  color: "#e8edf7",
  textDecoration: "none",
  fontWeight: 700
};

const solidButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.75rem 1rem",
  borderRadius: 12,
  border: "none",
  background: "#10b981",
  color: "#0b1221",
  fontWeight: 800,
  cursor: "pointer",
  textDecoration: "none"
};

export default function Home() {
  const { haBase, z2mBase } = useIntegrationBases();
  const [devices, setDevices] = useState<Record<string, Device>>({});
  const [floorplans, setFloorplans] = useState<FloorplanSummary[]>([]);
  const [currentFloorplan, setCurrentFloorplan] = useState<Floorplan | null>(null);
  const [selectedFloorplanId, setSelectedFloorplanId] = useState("");
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatLog, setChatLog] = useState<ChatTurn[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [intentInput, setIntentInput] = useState("");
  const [intentResult, setIntentResult] = useState<IntentResult | null>(null);
  const [intentStatus, setIntentStatus] = useState("");
  const [pageStatus, setPageStatus] = useState("");
  const [wsStatus, setWsStatus] = useState("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const allowedDeviceIdsRef = useRef<Set<string>>(new Set());

  const buildWsUrl = () => {
    if (process.env.NEXT_PUBLIC_WS_BASE) return process.env.NEXT_PUBLIC_WS_BASE;
    if (typeof window === "undefined") return "";
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.hostname;
    const port = process.env.NEXT_PUBLIC_WS_PORT || "4001";
    return `${proto}://${host}:${port}/ws`;
  };

  const loadFloorplans = async (preferredId?: string) => {
    const res = await fetch("/api/floorplans");
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.reason || data?.error || "加载户型失败");
    }
    const items = Array.isArray(data.items) ? data.items : [];
    setFloorplans(items);
    const nextId = resolveInitialFloorplanId(items, preferredId || getStoredFloorplanId() || selectedFloorplanId);
    if (!nextId) {
      setSelectedFloorplanId("");
      setCurrentFloorplan(null);
      setScenes([]);
      setDevices({});
      allowedDeviceIdsRef.current = new Set();
      return "";
    }
    if (nextId !== selectedFloorplanId) {
      setSelectedFloorplanId(nextId);
    }
    return nextId;
  };

  const loadScopedData = async (floorplanId: string) => {
    if (!floorplanId) {
      setCurrentFloorplan(null);
      setScenes([]);
      setDevices({});
      allowedDeviceIdsRef.current = new Set();
      return;
    }

    const [floorplanRes, devicesRes, scenesRes] = await Promise.all([
      fetch(`/api/floorplans/${encodeURIComponent(floorplanId)}`),
      fetch(`/api/devices?floorplanId=${encodeURIComponent(floorplanId)}`),
      fetch(`/api/scenes?floorplanId=${encodeURIComponent(floorplanId)}`)
    ]);

    const [floorplanJson, devicesJson, scenesJson] = await Promise.all([floorplanRes.json(), devicesRes.json(), scenesRes.json()]);
    if (!floorplanRes.ok) throw new Error(floorplanJson?.reason || floorplanJson?.error || "加载户型详情失败");
    if (!devicesRes.ok) throw new Error(devicesJson?.reason || devicesJson?.error || "加载设备失败");
    if (!scenesRes.ok) throw new Error(scenesJson?.reason || scenesJson?.error || "加载场景失败");

    const nextPlan = floorplanJson as Floorplan;
    const deviceMap: Record<string, Device> = {};
    for (const device of devicesJson.items || []) {
      if (!device?.id) continue;
      deviceMap[device.id] = device;
    }

    setCurrentFloorplan(nextPlan);
    setDevices(deviceMap);
    setScenes(Array.isArray(scenesJson.items) ? scenesJson.items : []);
    allowedDeviceIdsRef.current = new Set((nextPlan.devices || []).map((entry) => entry.deviceId));
    setStoredFloorplanId(floorplanId);
  };

  const refresh = async (preferredId?: string) => {
    setLoading(true);
    setPageStatus("");
    try {
      const nextId = await loadFloorplans(preferredId);
      if (nextId && nextId === selectedFloorplanId) {
        await loadScopedData(nextId);
      }
    } catch (err) {
      console.error(err);
      setPageStatus((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const connectWs = () => {
    const url = buildWsUrl();
    if (!url) return;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => setWsStatus("connected");
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type !== "device_update" && msg.type !== "state_snapshot") return;
          const nextDevice = msg.data;
          if (!nextDevice?.id) return;
          if (!allowedDeviceIdsRef.current.has(nextDevice.id)) return;
          setDevices((prev) => ({
            ...prev,
            [nextDevice.id]: {
              ...prev[nextDevice.id],
              ...nextDevice,
              traits: { ...(prev[nextDevice.id]?.traits || {}), ...(nextDevice.traits || {}) }
            }
          }));
        } catch (_err) {
          // ignore malformed messages
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        setWsStatus("reconnecting");
        setTimeout(connectWs, 2000);
      };
      ws.onerror = () => {
        setWsStatus("error");
        ws.close();
      };
    } catch (err) {
      console.error("WS connect failed", err);
      setWsStatus("error");
    }
  };

  useEffect(() => {
    refresh().catch((err) => {
      console.error(err);
      setPageStatus((err as Error).message);
    });
    connectWs();
    return () => {
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedFloorplanId) return;
    setLoading(true);
    setPageStatus("");
    loadScopedData(selectedFloorplanId)
      .catch((err) => {
        console.error(err);
        setPageStatus((err as Error).message);
      })
      .finally(() => setLoading(false));
  }, [selectedFloorplanId]);

  const deviceList = useMemo(
    () =>
      Object.values(devices).sort((a, b) => {
        const roomA = a.placement?.room || "";
        const roomB = b.placement?.room || "";
        return `${roomA}:${a.name}`.localeCompare(`${roomB}:${b.name}`, "zh-CN");
      }),
    [devices]
  );

  const roomSummary = useMemo(() => {
    const roomMap = new Map<string, { id: string; name: string; deviceCount: number }>();
    for (const room of currentFloorplan?.rooms || []) {
      roomMap.set(room.id, { id: room.id, name: room.name, deviceCount: 0 });
    }
    for (const entry of currentFloorplan?.devices || []) {
      const roomId = String(entry.roomId || "").trim();
      if (!roomId) continue;
      const target = roomMap.get(roomId);
      if (!target) continue;
      target.deviceCount += 1;
    }
    return Array.from(roomMap.values());
  }, [currentFloorplan]);

  const summary = useMemo(() => {
    let withHa = 0;
    let withZ2m = 0;
    let virtualDevices = 0;

    for (const device of deviceList) {
      const links = getDeviceExternalLinks(device, { haBase, z2mBase });
      if (links.haUrl) withHa += 1;
      if (links.zigbee2mqttUrl) withZ2m += 1;
      if (device.protocol === "virtual") virtualDevices += 1;
    }

    return {
      totalDevices: deviceList.length,
      rooms: roomSummary.length,
      scenes: scenes.length,
      withHa,
      withZ2m,
      virtualDevices
    };
  }, [deviceList, roomSummary, scenes, haBase, z2mBase]);

  const submitChat = async () => {
    if (!chatInput.trim()) return;
    const userTurn: ChatTurn = { role: "user", content: chatInput.trim() };
    setChatLog((prev) => [...prev, userTurn]);
    setChatBusy(true);
    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...chatLog, userTurn],
          model: "local-echo"
        })
      });
      const data = await resp.json();
      const assistantMessage = data?.choices?.[0]?.message?.content || "No response";
      setChatLog((prev) => [...prev, { role: "assistant", content: assistantMessage }]);
      setChatInput("");
    } catch (err) {
      setChatLog((prev) => [...prev, { role: "assistant", content: (err as Error).message }]);
    } finally {
      setChatBusy(false);
    }
  };

  const parseIntent = async () => {
    if (!intentInput.trim()) return;
    setIntentStatus("解析中...");
    try {
      const payload = {
        input: intentInput.trim(),
        devices: deviceList.map((device) => ({
          id: device.id,
          name: device.name,
          placement: device.placement,
          semantics: device.semantics,
          capabilities: device.capabilities
        }))
      };
      const resp = await fetch("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok) {
        setIntentStatus(data.error || "解析失败");
        return;
      }
      setIntentResult(data.intent);
      setIntentStatus("");
    } catch (err) {
      setIntentStatus((err as Error).message);
    }
  };

  const executeIntent = async () => {
    if (!intentResult?.deviceId || !intentResult.action) {
      setIntentStatus("缺少设备或动作");
      return;
    }
    const device = devices[intentResult.deviceId];
    if (!device) {
      setIntentStatus("设备不在当前户型中");
      return;
    }
    setIntentStatus("执行中...");
    try {
      const resp = await fetch(`/api/devices/${encodeURIComponent(device.id)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: intentResult.action, params: intentResult.params })
      });
      const data = await resp.json();
      if (!resp.ok) {
        setIntentStatus(data.reason || data.error || "执行失败");
        return;
      }
      setIntentStatus("已下发");
    } catch (err) {
      setIntentStatus((err as Error).message);
    }
  };

  const summaryCards = [
    { label: "当前户型设备", value: summary.totalDevices, testId: "summary-total-devices" },
    { label: "当前户型房间", value: summary.rooms, testId: "summary-total-rooms" },
    { label: "当前户型场景", value: summary.scenes, testId: "summary-total-scenes" },
    { label: "可跳转 HA", value: summary.withHa, testId: "summary-ha-bound" }
  ];

  const haHubHref = selectedFloorplanId ? `/ha-hub?floorplanId=${encodeURIComponent(selectedFloorplanId)}` : "/ha-hub";

  return (
    <>
      <Head>
        <title>Command Center</title>
      </Head>

      <main
        style={{
          minHeight: "calc(100vh - 80px)",
          background: pageBg,
          color: "#e8edf7",
          fontFamily: "'Manrope', 'Segoe UI', system-ui, -apple-system, sans-serif",
          padding: "2rem"
        }}
        data-testid="home-page"
      >
        <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div style={{ letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.82, fontSize: 12 }}>Command Center</div>
            <h1 style={{ margin: "0.25rem 0 0.45rem", fontSize: "2.2rem" }}>按户型切换的主页摘要</h1>
            <p style={{ margin: 0, maxWidth: 780, opacity: 0.82, lineHeight: 1.6 }}>
              首页现在以当前户型为上下文。房间、设备、场景和 HA Hub 入口都跟随户型切换，Home Assistant 作为镜像视图承接外部页面。
            </p>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Link href="/floorplan" style={linkButtonStyle}>
              打开户型编辑
            </Link>
            <Link href="/scenes" style={linkButtonStyle}>
              打开高级场景
            </Link>
            <Link href="/virtual-devices" style={linkButtonStyle}>
              打开虚拟设备
            </Link>
            <Link href={haHubHref} style={solidButtonStyle}>
              打开 HA Hub
            </Link>
            <button
              onClick={() => refresh(selectedFloorplanId)}
              disabled={loading}
              style={{ ...solidButtonStyle, boxShadow: "0 10px 24px rgba(16,185,129,0.24)" }}
            >
              {loading ? "刷新中..." : "刷新摘要"}
            </button>
          </div>
        </header>

        <section style={{ ...panelStyle, marginTop: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>当前户型</div>
              <div style={{ fontSize: 28, fontWeight: 900 }} data-testid="current-floorplan-name">
                {currentFloorplan?.name || "未选择户型"}
              </div>
              <div style={{ fontSize: 13, opacity: 0.75 }}>
                WebSocket: {wsStatus} · 虚拟设备: {summary.virtualDevices}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 260 }}>
              <label htmlFor="home-floorplan-select" style={{ fontSize: 12, opacity: 0.8 }}>
                切换户型
              </label>
              <select
                id="home-floorplan-select"
                value={selectedFloorplanId}
                onChange={(e) => setSelectedFloorplanId(e.target.value)}
                data-testid="current-floorplan-select"
                style={{
                  minWidth: 260,
                  padding: "0.85rem 0.95rem",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(0,0,0,0.25)",
                  color: "#e8edf7"
                }}
              >
                {!floorplans.length ? <option value="">暂无户型</option> : null}
                {floorplans.map((floorplan) => (
                  <option key={floorplan.id} value={floorplan.id}>
                    {floorplan.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {pageStatus ? <div style={{ marginTop: 12, fontSize: 13, color: "#fca5a5" }}>{pageStatus}</div> : null}
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginTop: 18 }}>
          {summaryCards.map((card) => (
            <div
              key={card.label}
              style={{
                ...panelStyle,
                background: "rgba(255,255,255,0.08)",
                padding: "0.9rem 1rem"
              }}
              data-testid={card.testId}
            >
              <div style={{ fontSize: 12, opacity: 0.75 }}>{card.label}</div>
              <div style={{ marginTop: 6, fontSize: 28, fontWeight: 900 }}>{card.value}</div>
            </div>
          ))}
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: "1.25rem", marginTop: "1.4rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={panelStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: "1.15rem" }}>空间摘要</h2>
                  <p style={{ margin: "8px 0 0", opacity: 0.78, fontSize: 13 }}>
                    主页显示当前户型的房间、设备和场景，不再混合全局数据。
                  </p>
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Link href={haHubHref} style={linkButtonStyle}>
                    进入当前户型 HA 镜像
                  </Link>
                  <Link href="/floorplan" style={linkButtonStyle}>
                    编辑户型与布点
                  </Link>
                </div>
              </div>

              {!currentFloorplan ? (
                <p style={{ marginTop: 16, opacity: 0.78 }}>还没有可用户型，先去户型编辑页创建。</p>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 16 }}>
                  <div
                    style={{
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 16,
                      padding: "1rem",
                      background: "rgba(7, 18, 35, 0.44)"
                    }}
                  >
                    <div style={{ fontWeight: 800, fontSize: "1.02rem" }}>房间 / Areas</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
                      {roomSummary.length ? (
                        roomSummary.map((room) => (
                          <span
                            key={room.id}
                            style={{
                              background: "rgba(255,255,255,0.08)",
                              borderRadius: 999,
                              padding: "0.4rem 0.65rem",
                              fontSize: 12
                            }}
                          >
                            {room.name} · {room.deviceCount}
                          </span>
                        ))
                      ) : (
                        <span style={{ opacity: 0.72, fontSize: 13 }}>当前户型没有房间。</span>
                      )}
                    </div>
                  </div>

                  <div
                    style={{
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 16,
                      padding: "1rem",
                      background: "rgba(7, 18, 35, 0.44)"
                    }}
                  >
                    <div style={{ fontWeight: 800, fontSize: "1.02rem" }}>场景 / Scenes</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
                      {scenes.length ? (
                        scenes.slice(0, 6).map((scene) => (
                          <div key={scene.id} style={{ paddingBottom: 8, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                            <div style={{ fontWeight: 700 }}>{scene.name}</div>
                            <div style={{ fontSize: 12, opacity: 0.72 }}>{scene.description || scene.id}</div>
                          </div>
                        ))
                      ) : (
                        <span style={{ opacity: 0.72, fontSize: 13 }}>当前户型没有带 scope 的场景。</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div style={panelStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: "1.15rem" }}>设备摘要</h2>
                  <p style={{ margin: "8px 0 0", opacity: 0.78, fontSize: 13 }}>只显示当前户型里已布点的设备。</p>
                </div>
                <Link href={haHubHref} style={linkButtonStyle}>
                  查看当前户型 HA 入口
                </Link>
              </div>

              {deviceList.length === 0 && !loading ? <p style={{ marginTop: 16, opacity: 0.78 }}>当前户型暂无设备数据。</p> : null}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, marginTop: 16 }}>
                {deviceList.map((device) => {
                  const links = getDeviceExternalLinks(device, { haBase, z2mBase });
                  const room = device.placement?.room || "未归类";
                  const traitSummary = formatTraitSummary(device.traits);
                  return (
                    <article
                      key={device.id}
                      style={{
                        border: "1px solid rgba(255,255,255,0.08)",
                        borderRadius: 16,
                        padding: "1rem",
                        background: "rgba(7, 18, 35, 0.44)",
                        boxShadow: "0 14px 30px rgba(0,0,0,0.16)"
                      }}
                      data-testid={`device-summary-card-${device.id}`}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: "1.04rem" }}>{device.name}</div>
                          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>{device.id}</div>
                        </div>
                        <span
                          style={{
                            background: "rgba(52, 211, 153, 0.9)",
                            color: "#0b1221",
                            padding: "0.3rem 0.7rem",
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: 700
                          }}
                        >
                          {room}
                        </span>
                      </div>

                      <div style={{ marginTop: 10, fontSize: 13, opacity: 0.84, lineHeight: 1.6 }}>
                        协议: {device.protocol || "unknown"}
                        {device.placement?.description ? ` · ${device.placement.description}` : ""}
                        {device.placement?.zone ? ` · zone=${device.placement.zone}` : ""}
                      </div>

                      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {traitSummary.map((entry) => (
                          <span
                            key={entry}
                            style={{
                              background: "rgba(255,255,255,0.08)",
                              borderRadius: 999,
                              padding: "0.3rem 0.55rem",
                              fontSize: 12
                            }}
                          >
                            {entry}
                          </span>
                        ))}
                        {!traitSummary.length ? (
                          <span
                            style={{
                              background: "rgba(255,255,255,0.08)",
                              borderRadius: 999,
                              padding: "0.3rem 0.55rem",
                              fontSize: 12
                            }}
                          >
                            暂无 traits
                          </span>
                        ) : null}
                      </div>

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                        {links.haUrl ? (
                          <a
                            href={links.haUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={linkButtonStyle}
                            data-testid={`device-open-ha-${device.id}`}
                          >
                            Open in HA
                          </a>
                        ) : (
                          <span style={{ ...linkButtonStyle, color: "#94a3b8", borderStyle: "dashed" }}>HA 未绑定</span>
                        )}

                        {links.zigbee2mqttUrl ? (
                          <a
                            href={links.zigbee2mqttUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={linkButtonStyle}
                            data-testid={`device-open-z2m-${device.id}`}
                          >
                            Open in Zigbee2MQTT
                          </a>
                        ) : (
                          <span style={{ ...linkButtonStyle, color: "#94a3b8", borderStyle: "dashed" }}>Z2M 未绑定</span>
                        )}

                        <Link href={`/scenes?deviceId=${encodeURIComponent(device.id)}`} style={linkButtonStyle}>
                          高级场景
                        </Link>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <section style={panelStyle}>
              <div>
                <h2 style={{ margin: "0 0 0.35rem 0" }}>LLM 代理（llm-bridge）</h2>
                <p style={{ margin: 0, opacity: 0.75, fontSize: 13 }}>自然语言入口仍保留，但解释上下文已经收敛到当前户型设备。</p>
              </div>
              <div
                style={{
                  background: "rgba(0,0,0,0.25)",
                  borderRadius: 14,
                  padding: "0.8rem",
                  minHeight: 220,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  marginTop: 12
                }}
              >
                {chatLog.length === 0 ? <div style={{ opacity: 0.7, fontSize: 14 }}>试着说：“打开客厅插座”。</div> : null}
                {chatLog.map((turn, idx) => (
                  <div
                    key={idx}
                    style={{
                      alignSelf: turn.role === "user" ? "flex-end" : "flex-start",
                      maxWidth: "90%",
                      background: turn.role === "user" ? "#1ec8a3" : "rgba(255,255,255,0.1)",
                      color: turn.role === "user" ? "#0b1221" : "#e8edf7",
                      padding: "0.55rem 0.75rem",
                      borderRadius: 12,
                      fontSize: 14,
                      boxShadow: "0 12px 24px rgba(0,0,0,0.15)"
                    }}
                  >
                    {turn.content}
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="输入你的指令..."
                  style={{
                    flex: 1,
                    padding: "0.9rem 1rem",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(0,0,0,0.3)",
                    color: "#e8edf7",
                    outline: "none"
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitChat();
                    }
                  }}
                />
                <button
                  onClick={submitChat}
                  disabled={chatBusy}
                  style={{
                    background: "#22d3ee",
                    border: "none",
                    color: "#0b1221",
                    padding: "0 1rem",
                    borderRadius: 12,
                    cursor: chatBusy ? "not-allowed" : "pointer",
                    fontWeight: 800,
                    minWidth: 90
                  }}
                >
                  {chatBusy ? "发送中" : "发送"}
                </button>
              </div>
            </section>

            <section style={panelStyle}>
              <div>
                <h2 style={{ margin: "0 0 0.35rem 0" }}>意图解析</h2>
                <p style={{ margin: 0, opacity: 0.75, fontSize: 13 }}>将自然语言转成推荐动作，可确认后下发。</p>
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <input
                  value={intentInput}
                  onChange={(e) => setIntentInput(e.target.value)}
                  placeholder="例如：把客厅灯调到 30%"
                  style={{
                    flex: 1,
                    padding: "0.8rem 1rem",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(0,0,0,0.35)",
                    color: "#e8edf7"
                  }}
                  data-testid="intent-input"
                />
                <button
                  onClick={parseIntent}
                  style={{
                    background: "#a855f7",
                    border: "none",
                    color: "#0b1221",
                    padding: "0 1rem",
                    borderRadius: 10,
                    cursor: "pointer",
                    fontWeight: 800
                  }}
                  data-testid="intent-parse"
                >
                  解析
                </button>
              </div>

              {intentResult ? (
                <div
                  style={{
                    marginTop: 12,
                    padding: "0.75rem",
                    borderRadius: 10,
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6
                  }}
                >
                  <div style={{ fontWeight: 700 }}>
                    动作：{intentResult.action} {intentResult.deviceId ? `@ ${intentResult.deviceId}` : ""}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    置信度：{Math.round((intentResult.confidence || 0) * 100)}% | {intentResult.summary || "无摘要"}
                  </div>
                  {intentResult.params && Object.keys(intentResult.params).length > 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      参数：{" "}
                      {Object.entries(intentResult.params)
                        .map(([key, value]) => `${key}=${value}`)
                        .join("，")}
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={executeIntent}
                      style={{
                        background: "#22c55e",
                        border: "none",
                        color: "#0b1221",
                        padding: "0.45rem 0.8rem",
                        borderRadius: 10,
                        cursor: "pointer",
                        fontWeight: 800
                      }}
                      data-testid="intent-exec"
                    >
                      执行动作
                    </button>
                    <button
                      onClick={() => {
                        setIntentResult(null);
                        setIntentStatus("");
                      }}
                      style={{
                        background: "rgba(255,255,255,0.1)",
                        border: "1px solid rgba(255,255,255,0.2)",
                        color: "#e8edf7",
                        padding: "0.45rem 0.8rem",
                        borderRadius: 10,
                        cursor: "pointer",
                        fontWeight: 700
                      }}
                    >
                      清除
                    </button>
                  </div>
                </div>
              ) : null}

              {intentStatus ? <div style={{ fontSize: 12, opacity: 0.82, marginTop: 12 }}>{intentStatus}</div> : null}
            </section>
          </div>
        </section>
      </main>
    </>
  );
}

function formatTraitSummary(traits?: Record<string, any>) {
  if (!traits) return [];
  const entries: string[] = [];
  for (const [key, value] of Object.entries(traits)) {
    if (typeof value !== "object" || value === null) {
      entries.push(`${key}: ${String(value)}`);
      continue;
    }

    const nested = Object.entries(value)
      .slice(0, 2)
      .map(([nestedKey, nestedValue]) => `${nestedKey}:${nestedValue}`)
      .join(" · ");
    entries.push(nested ? `${key} ${nested}` : key);
  }

  return entries.slice(0, 4);
}
