import { useEffect, useMemo, useRef, useState } from "react";

type CapabilityParam = {
  name: string;
  type: "boolean" | "number" | "string" | "enum";
  minimum?: number;
  maximum?: number;
  enum?: string[];
};

type Capability = {
  action: string;
  description?: string;
  parameters?: CapabilityParam[];
};

type Device = {
  id: string;
  name: string;
  placement?: { room?: string; zone?: string; description?: string };
  traits?: Record<string, any>;
  capabilities?: Capability[];
  semantics?: Record<string, any>;
};

type ChatTurn = { role: "user" | "assistant"; content: string };
type IntentResult = {
  action: string;
  deviceId?: string;
  params?: Record<string, any>;
  confidence?: number;
  summary?: string;
};

const gradient = "linear-gradient(135deg, #0f172a 0%, #1d293f 40%, #0b5b5c 100%)";

export default function Home() {
  const [devices, setDevices] = useState<Record<string, Device>>({});
  const [loading, setLoading] = useState(false);
  const [actionStatus, setActionStatus] = useState<Record<string, string>>({});
  const [paramInputs, setParamInputs] = useState<Record<string, Record<string, any>>>({});
  const [actionResults, setActionResults] = useState<Record<string, string>>({});
  const [chatInput, setChatInput] = useState("");
  const [chatLog, setChatLog] = useState<ChatTurn[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [intentInput, setIntentInput] = useState("");
  const [intentResult, setIntentResult] = useState<IntentResult | null>(null);
  const [intentStatus, setIntentStatus] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/devices");
      const data = await res.json();
      const map = {};
      for (const d of data.items || []) {
        map[d.id] = d;
      }
      setDevices(map);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    connectWs();
    return () => {
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAction = async (device: Device, action: string) => {
    setActionStatus((prev) => ({ ...prev, [device.id]: "sending..." }));
    try {
      const resp = await fetch(`/api/devices/${encodeURIComponent(device.id)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const data = await resp.json();
      if (!resp.ok) {
        setActionStatus((prev) => ({ ...prev, [device.id]: data.reason || data.error || "failed" }));
        return;
      }
      setActionStatus((prev) => ({ ...prev, [device.id]: "queued" }));
    } catch (err) {
      setActionStatus((prev) => ({ ...prev, [device.id]: (err as Error).message }));
    }
  };

  const toggleActions = useMemo(() => new Set(["turn_on", "turn_off", "toggle"]), []);

  const buildWsUrl = () => {
    if (process.env.NEXT_PUBLIC_WS_BASE) return process.env.NEXT_PUBLIC_WS_BASE;
    if (typeof window === "undefined") return "";
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.hostname;
    const port = process.env.NEXT_PUBLIC_WS_PORT || "4001";
    return `${proto}://${host}:${port}/ws`;
  };

  const connectWs = () => {
    const url = buildWsUrl();
    if (!url) return;
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        console.log("WS connected", url);
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "device_update" || msg.type === "state_snapshot") {
            const d = msg.data;
            if (!d?.id) return;
            setDevices((prev) => ({
              ...prev,
              [d.id]: {
                ...prev[d.id],
                ...d,
                traits: { ...(prev[d.id]?.traits || {}), ...(d.traits || {}) }
              }
            }));
          }
          if (msg.type === "action_result") {
            const res = msg.data;
            const deviceId = res?.deviceId || res?.id;
            if (!deviceId) return;
            setActionResults((prev) => ({
              ...prev,
              [deviceId]: `${res.action || ""} -> ${res.status}${res.reason ? ` (${res.reason})` : ""}`
            }));
          }
        } catch (_err) {
          // ignore malformed messages
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        setTimeout(connectWs, 2000);
      };
      ws.onerror = () => {
        ws.close();
      };
    } catch (err) {
      console.error("WS connect failed", err);
    }
  };

  const deviceList = useMemo(() => Object.values(devices), [devices]);

  const onParamChange = (deviceId: string, action: string, name: string, value: any) => {
    setParamInputs((prev) => ({
      ...prev,
      [`${deviceId}:${action}`]: {
        ...(prev[`${deviceId}:${action}`] || {}),
        [name]: value
      }
    }));
  };

  const handleParamAction = async (device: Device, capability: Capability) => {
    const key = `${device.id}:${capability.action}`;
    const inputs = paramInputs[key] || {};
    const params = { ...inputs };
    // best-effort number casting
    capability.parameters?.forEach((p) => {
      if (p.type === "number" && params[p.name] !== undefined) {
        const n = Number(params[p.name]);
        params[p.name] = Number.isFinite(n) ? n : params[p.name];
      }
      if (p.type === "boolean" && typeof params[p.name] !== "boolean") {
        params[p.name] = params[p.name] === "true" ? true : params[p.name] === "false" ? false : params[p.name];
      }
    });
    setActionStatus((prev) => ({ ...prev, [device.id]: "sending..." }));
    try {
      const resp = await fetch(`/api/devices/${encodeURIComponent(device.id)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: capability.action, params })
      });
      const data = await resp.json();
      if (!resp.ok) {
        setActionStatus((prev) => ({ ...prev, [device.id]: data.reason || data.error || "failed" }));
        return;
      }
      setActionStatus((prev) => ({ ...prev, [device.id]: "queued" }));
    } catch (err) {
      setActionStatus((prev) => ({ ...prev, [device.id]: (err as Error).message }));
    }
  };

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
        devices: deviceList.map((d) => ({
          id: d.id,
          name: d.name,
          placement: d.placement,
          semantics: d.semantics,
          capabilities: d.capabilities
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
      setIntentStatus("设备不在列表中");
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

  return (
    <main
      style={{
        minHeight: "100vh",
        background: gradient,
        color: "#e8edf7",
        fontFamily: "'Manrope', 'Segoe UI', system-ui, -apple-system, sans-serif",
        padding: "2.5rem"
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.8, fontSize: 12 }}>
            Local Smart House
          </div>
          <h1 style={{ margin: "0.2rem 0 0.4rem 0", fontSize: "2rem" }}>控制台 + LLM 体验</h1>
          <p style={{ margin: 0, maxWidth: 600, opacity: 0.85 }}>
            浏览设备，快速触发开关，或让 LLM 代理你的意图（通过 llm-bridge echo/代理接口）。
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <a
            href="/floorplan"
            style={{
              padding: "0.7rem 0.9rem",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(0,0,0,0.18)",
              color: "#e8edf7",
              textDecoration: "none",
              fontWeight: 700
            }}
          >
            户型
          </a>
          <a
            href="/scenes"
            style={{
              padding: "0.7rem 0.9rem",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(0,0,0,0.18)",
              color: "#e8edf7",
              textDecoration: "none",
              fontWeight: 700
            }}
          >
            场景
          </a>
          <a
            href="/automations"
            style={{
              padding: "0.7rem 0.9rem",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(0,0,0,0.18)",
              color: "#e8edf7",
              textDecoration: "none",
              fontWeight: 700
            }}
          >
            联动
          </a>
          <button
            onClick={refresh}
            disabled={loading}
            style={{
              background: "#10b981",
              border: "none",
              color: "#0b1221",
              padding: "0.8rem 1.2rem",
              borderRadius: 10,
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: 700,
              boxShadow: "0 10px 30px rgba(16,185,129,0.25)"
            }}
          >
            {loading ? "刷新中..." : "刷新设备"}
          </button>
        </div>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "1.5rem", marginTop: "1.5rem" }}>
        <div
          style={{
            background: "rgba(255,255,255,0.04)",
            borderRadius: 16,
            padding: "1rem",
            border: "1px solid rgba(255,255,255,0.08)"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", marginBottom: "1rem" }}>
            <h2 style={{ margin: 0, fontSize: "1.2rem" }}>设备列表</h2>
            {loading && <span style={{ opacity: 0.7 }}>加载中...</span>}
          </div>
          {deviceList.length === 0 && !loading && <p style={{ opacity: 0.8 }}>暂无设备数据。</p>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "1rem" }}>
            {deviceList.map((device) => {
              const room = device.placement?.room || "未知位置";
              const description = device.placement?.description || device.placement?.zone;
              const traits = Object.entries(device.traits || {});
              const quickActions = device.capabilities?.filter((c) => toggleActions.has(c.action)) || [];
              const paramActions = device.capabilities?.filter((c) => (c.parameters || []).length > 0) || [];
              return (
                <div
                  key={device.id}
                  style={{
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 14,
                    padding: "1rem",
                    background: "rgba(16, 24, 40, 0.4)",
                    boxShadow: "0 12px 30px rgba(0,0,0,0.15)"
                  }}
                  data-testid={`device-card-${device.id}`}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>{device.name}</div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>{device.id}</div>
                    </div>
                    <span
                      style={{
                        background: "#1ec8a3",
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
                  {description && <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8 }}>{description}</div>}

                  {traits.length > 0 && (
                    <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {traits.map(([key, value]) => (
                        <span
                          key={key}
                          style={{
                            background: "rgba(255,255,255,0.06)",
                            borderRadius: 10,
                            padding: "0.35rem 0.6rem",
                            fontSize: 12,
                            letterSpacing: 0.2
                          }}
                        >
                          {key}: {formatTrait(value)}
                        </span>
                      ))}
                    </div>
                  )}

                  {quickActions.length > 0 && (
                    <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {quickActions.map((cap) => (
                        <button
                          key={`${device.id}-${cap.action}`}
                          onClick={() => handleAction(device, cap.action)}
                          style={{
                            background: cap.action === "turn_off" ? "#fca5a5" : "#34d399",
                            border: "none",
                            color: "#0b1221",
                            padding: "0.55rem 0.9rem",
                            borderRadius: 10,
                            cursor: "pointer",
                            fontWeight: 700,
                            boxShadow: "0 10px 24px rgba(0,0,0,0.18)"
                          }}
                          data-testid={`quick-${device.id}-${cap.action}`}
                        >
                          {cap.action === "turn_on" ? "开" : cap.action === "turn_off" ? "关" : cap.action}
                        </button>
                      ))}
                      {actionStatus[device.id] && (
                        <span style={{ fontSize: 12, opacity: 0.8 }}>{actionStatus[device.id]}</span>
                      )}
                    </div>
                  )}

                  {paramActions.length > 0 && (
                    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>参数化动作</div>
                      {paramActions.map((cap) => {
                        const key = `${device.id}:${cap.action}`;
                        return (
                              <div
                                key={cap.action}
                                style={{
                                  padding: "0.6rem",
                                  borderRadius: 10,
                              background: "rgba(255,255,255,0.04)",
                              border: "1px solid rgba(255,255,255,0.05)",
                              display: "flex",
                              flexDirection: "column",
                              gap: 6
                            }}
                          >
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                  <span style={{ fontWeight: 700 }}>{cap.action}</span>
                                  <button
                                    onClick={() => handleParamAction(device, cap)}
                                    style={{
                                  background: "#38bdf8",
                                  border: "none",
                                  color: "#0b1221",
                                  padding: "0.35rem 0.7rem",
                                  borderRadius: 8,
                                  cursor: "pointer",
                                      fontWeight: 700,
                                      boxShadow: "0 6px 16px rgba(56,189,248,0.25)"
                                    }}
                                    data-testid={`send-${device.id}-${cap.action}`}
                                  >
                                    发送
                                  </button>
                                </div>
                                {cap.parameters?.map((p) => (
                                  <ParamInput
                                    key={`${cap.action}-${p.name}`}
                                    param={p}
                                    value={(paramInputs[key] || {})[p.name]}
                                    onChange={(val) => onParamChange(device.id, cap.action, p.name, val)}
                                    deviceId={device.id}
                                    action={cap.action}
                                  />
                                ))}
                              </div>
                            );
                          })}
                    </div>
                  )}

                  {actionResults[device.id] && (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
                      最近动作：{actionResults[device.id]}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            background: "rgba(255,255,255,0.06)",
            borderRadius: 16,
            padding: "1rem",
            border: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            flexDirection: "column",
            gap: "0.8rem"
          }}
        >
          <div>
            <h2 style={{ margin: "0 0 0.2rem 0" }}>LLM 代理（llm-bridge）</h2>
            <p style={{ margin: 0, opacity: 0.75, fontSize: 13 }}>
              默认回显；设置 llm-bridge 的 `UPSTREAM_API_BASE` 后会转发到真实模型。
            </p>
          </div>
          <div
            style={{
              background: "rgba(0,0,0,0.25)",
              borderRadius: 12,
              padding: "0.8rem",
              minHeight: 220,
              display: "flex",
              flexDirection: "column",
              gap: 8
            }}
          >
            {chatLog.length === 0 && <div style={{ opacity: 0.7, fontSize: 14 }}>试着说：“打开客厅插座”。</div>}
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
          <div style={{ display: "flex", gap: 10 }}>
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
                minWidth: 90,
                boxShadow: "0 10px 24px rgba(34,211,238,0.35)"
              }}
            >
              {chatBusy ? "发送中" : "发送"}
            </button>
          </div>
          <div
            style={{
              marginTop: 16,
              padding: "0.8rem",
              borderRadius: 12,
              background: "rgba(0,0,0,0.35)",
              border: "1px solid rgba(255,255,255,0.06)",
              display: "flex",
              flexDirection: "column",
              gap: 10
            }}
          >
            <div>
              <h3 style={{ margin: "0 0 0.4rem 0" }}>意图解析 → 执行动作</h3>
              <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>
                将自然语言转成推荐动作，可确认后下发设备。
              </p>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
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
                  fontWeight: 800,
                  boxShadow: "0 10px 24px rgba(168,85,247,0.35)"
                }}
                data-testid="intent-parse"
              >
                解析
              </button>
            </div>
            {intentResult && (
              <div
                style={{
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
                {intentResult.params && Object.keys(intentResult.params).length > 0 && (
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    参数：{" "}
                    {Object.entries(intentResult.params)
                      .map(([k, v]) => `${k}=${v}`)
                      .join("，")}
                  </div>
                )}
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
            )}
            {intentStatus && <div style={{ fontSize: 12, opacity: 0.8 }}>{intentStatus}</div>}
          </div>
        </div>
      </section>
    </main>
  );
}

function formatTrait(value: any) {
  if (typeof value !== "object" || value === null) return String(value);
  const entries = Object.entries(value)
    .map(([k, v]) => `${k}:${v}`)
    .join(" · ");
  return entries || "unknown";
}

type ParamInputProps = {
  param: CapabilityParam;
  value: any;
  onChange: (val: any) => void;
  deviceId: string;
  action: string;
};

function ParamInput({ param, value, onChange, deviceId, action }: ParamInputProps) {
  const label = `${param.name}${param.required ? " *" : ""}`;
  if (param.type === "enum" && Array.isArray(param.enum)) {
    return (
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
        <span style={{ opacity: 0.8 }}>{label}</span>
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          style={{
            padding: "0.45rem 0.5rem",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.2)",
            background: "rgba(0,0,0,0.25)",
            color: "#e8edf7"
          }}
          data-testid={`param-${deviceId}-${action}-${param.name}`}
        >
          <option value="">选择...</option>
          {param.enum.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (param.type === "boolean") {
    return (
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span style={{ opacity: 0.85 }}>{label}</span>
      </label>
    );
  }

  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
      <span style={{ opacity: 0.8 }}>
        {label}{" "}
        {param.minimum !== undefined || param.maximum !== undefined
          ? `(范围 ${param.minimum ?? "-"} ~ ${param.maximum ?? "-"})`
          : ""}
      </span>
      <input
        value={value ?? ""}
        onChange={(e) => onChange(param.type === "number" ? e.target.valueAsNumber : e.target.value)}
        type={param.type === "number" ? "number" : "text"}
        min={param.minimum}
        max={param.maximum}
        style={{
          padding: "0.45rem 0.5rem",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.2)",
          background: "rgba(0,0,0,0.25)",
          color: "#e8edf7"
        }}
        data-testid={`param-${deviceId}-${action}-${param.name}`}
      />
    </label>
  );
}
