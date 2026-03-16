import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/router";

import type { Device } from "../../lib/device-types";
import { getDeviceExternalLinks } from "../../lib/integrations";

type ActionResult = {
  id: string;
  action: string;
  status: string;
  transport: string;
  createdAt?: string;
};

const pageBg = "linear-gradient(135deg, #f8fafc 0%, #eef4ff 45%, #f4faf6 100%)";

export default function DevicePage() {
  const router = useRouter();
  const { id } = router.query;
  const [device, setDevice] = useState<Device | null>(null);
  const [history, setHistory] = useState<ActionResult[]>([]);
  const [action, setAction] = useState("");
  const [params, setParams] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!id || Array.isArray(id)) return;
    const load = async () => {
      const deviceRes = await fetch(`/api/devices/${encodeURIComponent(id)}`);
      const nextDevice = await deviceRes.json();
      setDevice(nextDevice);
      const historyRes = await fetch(`/api/devices/${encodeURIComponent(id)}/history?limit=10`);
      const nextHistory = await historyRes.json();
      setHistory(nextHistory.items || []);
    };
    load();
  }, [id]);

  const links = useMemo(() => getDeviceExternalLinks(device), [device]);

  const sendAction = async () => {
    if (!id || Array.isArray(id) || !action) return;
    setLoading(true);
    setMessage("");
    try {
      const body: { action: string; params?: Record<string, any> } = { action };
      if (params) {
        try {
          body.params = JSON.parse(params);
        } catch {
          setMessage("参数必须是 JSON 对象");
          setLoading(false);
          return;
        }
      }
      const resp = await fetch(`/api/devices/${encodeURIComponent(id)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (!resp.ok) {
        setMessage(`失败: ${data.error || resp.status}`);
      } else {
        setMessage("已发送");
      }
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main
      style={{
        minHeight: "calc(100vh - 80px)",
        padding: "2rem",
        fontFamily: "'Manrope', 'Segoe UI', system-ui, -apple-system, sans-serif",
        background: pageBg,
        color: "#0f172a"
      }}
    >
      {!device ? <p>Loading...</p> : null}

      {device ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 920 }}>
          <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "#64748b" }}>Legacy Device Detail</div>
              <h1 style={{ margin: "0.2rem 0 0.35rem" }}>{device.name}</h1>
              <p style={{ margin: 0, color: "#475569", lineHeight: 1.6 }}>
                设备详情页保留为过渡入口。完整设备管理、历史和实体运维建议优先在 Home Assistant 中进行。
              </p>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {links.haUrl ? (
                <a
                  href={links.haUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={externalButtonStyle("#0f172a", "#f8fafc")}
                  data-testid="device-page-open-ha"
                >
                  Open in HA
                </a>
              ) : (
                <span style={disabledBadgeStyle}>HA 未绑定</span>
              )}
              {links.zigbee2mqttUrl ? (
                <a
                  href={links.zigbee2mqttUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={externalButtonStyle("#dbeafe", "#0f172a")}
                  data-testid="device-page-open-z2m"
                >
                  Open in Zigbee2MQTT
                </a>
              ) : (
                <span style={disabledBadgeStyle}>Z2M 未绑定</span>
              )}
            </div>
          </header>

          <section
            style={{
              borderRadius: 18,
              border: "1px solid rgba(148, 163, 184, 0.2)",
              background: "rgba(255,255,255,0.86)",
              padding: "1rem 1.1rem"
            }}
          >
            <h2 style={{ margin: 0, fontSize: 16 }}>设备摘要</h2>
            <p style={{ margin: "10px 0 0", color: "#475569" }}>ID: {device.id}</p>
            <p style={{ margin: "6px 0 0", color: "#475569" }}>protocol: {device.protocol || "unknown"}</p>
            <p style={{ margin: "6px 0 0", color: "#475569" }}>
              placement: {[device.placement?.room, device.placement?.zone, device.placement?.description].filter(Boolean).join(" / ") || "未配置"}
            </p>
          </section>

          <section
            style={{
              borderRadius: 18,
              border: "1px solid rgba(148, 163, 184, 0.2)",
              background: "rgba(255,255,255,0.86)",
              padding: "1rem 1.1rem"
            }}
          >
            <h2 style={{ marginTop: 0 }}>动作调试</h2>
            <p style={{ marginTop: 0, color: "#475569" }}>保留当前调试能力，但不再作为主设备控制入口。</p>

            <select value={action} onChange={(e) => setAction(e.target.value)} style={inputStyle}>
              <option value="">选择动作</option>
              {device.capabilities?.map((capability) => (
                <option key={capability.action} value={capability.action}>
                  {capability.action}
                </option>
              ))}
            </select>

            <textarea
              placeholder='参数 JSON (可选，如 {"brightness":80})'
              value={params}
              onChange={(e) => setParams(e.target.value)}
              style={{ ...inputStyle, display: "block", width: "100%", minHeight: "92px", marginTop: "10px" }}
            />

            <button onClick={sendAction} disabled={loading || !action} style={{ ...externalButtonStyle("#0f766e", "#f8fafc"), marginTop: "10px" }}>
              {loading ? "发送中..." : "发送动作"}
            </button>

            {message ? <p style={{ color: "#475569" }}>{message}</p> : null}
          </section>

          <section
            style={{
              borderRadius: 18,
              border: "1px solid rgba(148, 163, 184, 0.2)",
              background: "rgba(255,255,255,0.86)",
              padding: "1rem 1.1rem"
            }}
          >
            <h2 style={{ marginTop: 0 }}>最近动作历史</h2>
            <ul style={{ margin: 0, paddingLeft: "1.1rem", color: "#334155" }}>
              {history.map((item) => (
                <li key={item.id} style={{ marginTop: 8 }}>
                  {item.action} - {item.status} ({item.transport}) {item.createdAt ? new Date(item.createdAt).toLocaleString() : ""}
                </li>
              ))}
              {!history.length ? <li>暂无动作历史</li> : null}
            </ul>
          </section>
        </div>
      ) : null}
    </main>
  );
}

const inputStyle: CSSProperties = {
  borderRadius: 12,
  border: "1px solid rgba(148, 163, 184, 0.4)",
  padding: "0.7rem 0.8rem",
  font: "inherit",
  background: "#fff"
};

function externalButtonStyle(background: string, color: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.7rem 1rem",
    borderRadius: 12,
    textDecoration: "none",
    fontWeight: 700,
    background,
    color,
    border: "none"
  };
}

const disabledBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.7rem 1rem",
  borderRadius: 12,
  color: "#94a3b8",
  background: "rgba(148, 163, 184, 0.12)",
  border: "1px dashed rgba(148, 163, 184, 0.4)"
};
