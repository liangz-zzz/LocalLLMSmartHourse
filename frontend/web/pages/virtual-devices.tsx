import Head from "next/head";
import Link from "next/link";
import { useEffect, useState } from "react";

type VirtualConfig = {
  enabled?: boolean;
  defaults?: { latency_ms?: number; failure_rate?: number };
  devices?: Array<{ id?: string; name?: string; protocol?: string }>;
};

type VirtualModel = {
  id: string;
  name: string;
  category?: string;
};

const pageBg = "linear-gradient(135deg, #f7f4eb 0%, #f2f6ff 48%, #f6fbf5 100%)";

const panelStyle = {
  background: "rgba(255,255,255,0.84)",
  borderRadius: 18,
  border: "1px solid rgba(148, 163, 184, 0.18)",
  padding: "1rem 1.1rem",
  boxShadow: "0 16px 40px rgba(15, 23, 42, 0.06)"
};

const ctaStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.7rem 1rem",
  borderRadius: 12,
  fontWeight: 700,
  textDecoration: "none"
};

export default function VirtualDevicesPage() {
  const [config, setConfig] = useState<VirtualConfig | null>(null);
  const [models, setModels] = useState<VirtualModel[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const [configRes, modelRes] = await Promise.all([fetch("/api/virtual-devices/config"), fetch("/api/virtual-devices/models")]);
        const configJson = await configRes.json();
        const modelJson = await modelRes.json();
        setConfig(configJson || {});
        setModels(modelJson.items || []);
      } catch (err) {
        setStatus((err as Error).message);
      }
    };

    load();
  }, []);

  return (
    <>
      <Head>
        <title>Virtual Devices</title>
      </Head>
      <main
        style={{
          minHeight: "calc(100vh - 80px)",
          background: pageBg,
          fontFamily: '"Space Grotesk", "Avenir Next", "Noto Sans", sans-serif',
          color: "#0f172a",
          padding: "24px"
        }}
        data-testid="virtual-devices-page"
      >
        <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "#475569" }}>Virtual Devices</div>
            <h1 style={{ margin: "0.2rem 0 0.45rem", fontSize: "2rem" }}>保留自研的模拟设备能力</h1>
            <p style={{ margin: 0, maxWidth: 760, color: "#475569", lineHeight: 1.6 }}>
              虚拟设备用于联调设备模型、Agent 链路和户型布点。v1 继续通过户型编辑页进行完整维护，这里提供配置概览和工作入口。
            </p>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Link href="/floorplan" style={{ ...ctaStyle, background: "#0f172a", color: "#f8fafc" }}>
              去户型页管理虚拟设备
            </Link>
            <Link href="/scenes" style={{ ...ctaStyle, background: "#e2e8f0", color: "#0f172a" }}>
              去高级场景联调
            </Link>
          </div>
        </header>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, marginTop: 20 }}>
          <div style={panelStyle}>
            <h2 style={{ margin: 0, fontSize: 16 }}>配置状态</h2>
            <p style={{ margin: "10px 0 0", color: "#475569" }}>{config?.enabled ? "模拟器已启用" : "模拟器未启用"}</p>
          </div>
          <div style={panelStyle}>
            <h2 style={{ margin: 0, fontSize: 16 }}>已保存模拟设备</h2>
            <p style={{ margin: "10px 0 0", color: "#475569" }}>{config?.devices?.length || 0} 个</p>
          </div>
          <div style={panelStyle}>
            <h2 style={{ margin: 0, fontSize: 16 }}>型号模板</h2>
            <p style={{ margin: "10px 0 0", color: "#475569" }}>{models.length} 个</p>
          </div>
          <div style={panelStyle}>
            <h2 style={{ margin: 0, fontSize: 16 }}>默认延迟 / 失败率</h2>
            <p style={{ margin: "10px 0 0", color: "#475569" }}>
              {config?.defaults?.latency_ms ?? 0} ms / {config?.defaults?.failure_rate ?? 0}
            </p>
          </div>
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, marginTop: 20 }}>
          <div style={panelStyle}>
            <h2 style={{ margin: 0, fontSize: 18 }}>最近的模拟设备</h2>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              {(config?.devices || []).slice(0, 6).map((device) => (
                <div
                  key={device.id || device.name}
                  style={{
                    borderRadius: 14,
                    border: "1px solid rgba(148, 163, 184, 0.2)",
                    padding: "0.75rem 0.85rem",
                    background: "#fff"
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{device.name || device.id}</div>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{device.id}</div>
                  <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>protocol: {device.protocol || "virtual"}</div>
                </div>
              ))}
              {!config?.devices?.length && <p style={{ margin: 0, color: "#64748b" }}>还没有保存的模拟设备。</p>}
            </div>
          </div>

          <div style={panelStyle}>
            <h2 style={{ margin: 0, fontSize: 18 }}>型号模板</h2>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              {models.slice(0, 6).map((model) => (
                <div
                  key={model.id}
                  style={{
                    borderRadius: 14,
                    border: "1px solid rgba(148, 163, 184, 0.2)",
                    padding: "0.75rem 0.85rem",
                    background: "#fff"
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{model.name}</div>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{model.id}</div>
                  {model.category ? <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>category: {model.category}</div> : null}
                </div>
              ))}
              {!models.length && <p style={{ margin: 0, color: "#64748b" }}>还没有型号模板。</p>}
            </div>
          </div>
        </section>

        {status ? (
          <div style={{ ...panelStyle, marginTop: 20 }}>
            <strong>加载状态</strong>
            <p style={{ margin: "8px 0 0", color: "#475569" }}>{status}</p>
          </div>
        ) : null}
      </main>
    </>
  );
}
