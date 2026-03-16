import Head from "next/head";

import { getHaBaseUrl, getHaHubLinks, getZ2MBaseUrl } from "../lib/integrations";

const pageBg = "linear-gradient(135deg, #eef4ff 0%, #f7fafc 45%, #edf7f2 100%)";

const panelStyle = {
  background: "rgba(255,255,255,0.85)",
  borderRadius: 18,
  border: "1px solid rgba(148, 163, 184, 0.18)",
  padding: "1rem 1.1rem",
  boxShadow: "0 16px 40px rgba(15, 23, 42, 0.06)"
};

const linkStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.65rem 0.95rem",
  borderRadius: 12,
  fontWeight: 700,
  textDecoration: "none"
};

function ExternalLinkButton({ href, label, testId }: { href: string; label: string; testId: string }) {
  if (!href) {
    return (
      <span
        data-testid={testId}
        style={{
          ...linkStyle,
          color: "#94a3b8",
          background: "#f8fafc",
          border: "1px dashed rgba(148, 163, 184, 0.45)"
        }}
      >
        {label} 未配置
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid={testId}
      style={{
        ...linkStyle,
        color: "#f8fafc",
        background: "#0f172a",
        border: "1px solid #0f172a"
      }}
    >
      {label}
    </a>
  );
}

export default function HaHubPage() {
  const haLinks = getHaHubLinks();
  const haBase = getHaBaseUrl();
  const z2mBase = getZ2MBaseUrl();

  const sections = [
    { key: "overview", title: "Overview / Dashboard", description: "面向日常控制的 HA 仪表盘、总览页和卡片生态。", href: haLinks.dashboards || haLinks.overview },
    { key: "areas", title: "Areas / Floors / Devices", description: "设备分组、楼层、房间和实体管理。", href: haLinks.areas || haLinks.devices },
    { key: "automations", title: "Automations / Scripts", description: "基础自动化、脚本、规则配置。", href: haLinks.automations },
    { key: "scenes", title: "Scenes", description: "基础场景管理，适合状态快照类场景。", href: haLinks.scenes },
    { key: "history", title: "History / Activity", description: "历史曲线、日志、活动追踪。", href: haLinks.history || haLinks.logbook },
    { key: "logbook", title: "Logbook", description: "事件时间线和活动记录。", href: haLinks.logbook }
  ];

  return (
    <>
      <Head>
        <title>HA Hub</title>
      </Head>
      <main
        style={{
          minHeight: "calc(100vh - 80px)",
          background: pageBg,
          fontFamily: '"Space Grotesk", "Avenir Next", "Noto Sans", sans-serif',
          color: "#0f172a",
          padding: "24px"
        }}
        data-testid="ha-hub-page"
      >
        <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "#475569" }}>Home Assistant Hub</div>
            <h1 style={{ margin: "0.2rem 0 0.45rem", fontSize: "2rem" }}>复用 HA 的成熟前端生态</h1>
            <p style={{ margin: 0, maxWidth: 760, color: "#475569", lineHeight: 1.6 }}>
              这里集中承载通用智能家居入口。HA 负责设备管理、自动化、历史和卡片化展示；本平台保留 LLM、户型、设备布点、虚拟设备和高级场景。
            </p>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <ExternalLinkButton href={haBase} label="打开 HA 根页面" testId="ha-root-link" />
            <ExternalLinkButton href={z2mBase} label="打开 Zigbee2MQTT" testId="z2m-root-link" />
          </div>
        </header>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginTop: 20 }}>
          <div style={panelStyle}>
            <h2 style={{ margin: 0, fontSize: 16 }}>集成策略</h2>
            <p style={{ margin: "10px 0 0", color: "#475569", lineHeight: 1.6 }}>
              v1 使用深链，不做 iframe、SSO 或整页代理。所有入口默认新标签页打开，避免打断当前前端的聊天、户型编辑和场景编排状态。
            </p>
          </div>
          <div style={panelStyle}>
            <h2 style={{ margin: 0, fontSize: 16 }}>当前平台保留</h2>
            <p style={{ margin: "10px 0 0", color: "#475569", lineHeight: 1.6 }}>
              统一设备模型、意图解析、户型图编辑与设备布点、虚拟设备、agentic scene 都继续在本平台维护，不迁移到 HA。
            </p>
          </div>
          <div style={panelStyle}>
            <h2 style={{ margin: 0, fontSize: 16 }}>环境状态</h2>
            <p style={{ margin: "10px 0 0", color: "#475569", lineHeight: 1.6 }}>HA Base: {haBase || "未配置"}</p>
            <p style={{ margin: "6px 0 0", color: "#475569", lineHeight: 1.6 }}>Zigbee2MQTT Base: {z2mBase || "未配置"}</p>
          </div>
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginTop: 20 }}>
          {sections.map((section) => (
            <article key={section.key} style={panelStyle}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{section.title}</h2>
              <p style={{ margin: "10px 0 14px", color: "#475569", lineHeight: 1.6 }}>{section.description}</p>
              <ExternalLinkButton href={section.href || ""} label={`打开 ${section.title}`} testId={`ha-hub-link-${section.key}`} />
            </article>
          ))}
        </section>
      </main>
    </>
  );
}
