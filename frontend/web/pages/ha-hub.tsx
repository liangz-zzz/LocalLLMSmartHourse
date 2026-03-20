import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";

import type { FloorplanSummary } from "../lib/floorplan-context";
import { getStoredFloorplanId, resolveInitialFloorplanId, setStoredFloorplanId } from "../lib/floorplan-context";
import { getHaBaseUrl, getHaHubLinks, getMirroredHaDashboardUrl, getZ2MBaseUrl } from "../lib/integrations";

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

type HaSyncStatus = {
  enabled: boolean;
  reason?: string;
  running?: boolean;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastReport?: {
    ok?: boolean;
    syncedAt?: string;
    counts?: Record<string, number>;
  };
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
  const router = useRouter();
  const haLinks = getHaHubLinks();
  const haBase = getHaBaseUrl();
  const z2mBase = getZ2MBaseUrl();
  const [floorplans, setFloorplans] = useState<FloorplanSummary[]>([]);
  const [selectedFloorplanId, setSelectedFloorplanId] = useState("");
  const [syncStatus, setSyncStatus] = useState<HaSyncStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [statusText, setStatusText] = useState("");

  const selectedFloorplan = useMemo(
    () => floorplans.find((floorplan) => floorplan.id === selectedFloorplanId) || null,
    [floorplans, selectedFloorplanId]
  );
  const mirroredDashboardUrl = selectedFloorplanId ? getMirroredHaDashboardUrl(selectedFloorplanId) : "";

  const load = async () => {
    setLoading(true);
    setStatusText("");
    try {
      const [floorplansRes, syncRes] = await Promise.all([fetch("/api/floorplans"), fetch("/api/ha/sync")]);
      const [floorplansJson, syncJson] = await Promise.all([floorplansRes.json(), syncRes.json()]);
      if (!floorplansRes.ok) throw new Error(floorplansJson?.reason || floorplansJson?.error || "加载户型失败");
      const items = Array.isArray(floorplansJson.items) ? floorplansJson.items : [];
      setFloorplans(items);
      setSyncStatus(syncRes.ok ? syncJson : { enabled: false, reason: syncJson?.reason || syncJson?.error || "ha_sync_unavailable" });
      const queryFloorplanId = typeof router.query.floorplanId === "string" ? router.query.floorplanId : "";
      const nextId = resolveInitialFloorplanId(items, queryFloorplanId || getStoredFloorplanId() || selectedFloorplanId);
      if (nextId) {
        setSelectedFloorplanId(nextId);
        setStoredFloorplanId(nextId);
      } else {
        setSelectedFloorplanId("");
      }
    } catch (err) {
      setStatusText((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const triggerSync = async () => {
    setSyncing(true);
    setStatusText("");
    try {
      const resp = await fetch("/api/ha/sync", { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.reason || data?.error || "同步失败");
      }
      setSyncStatus(data);
      setStatusText("HA 镜像已触发同步。");
    } catch (err) {
      setStatusText((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    if (!router.isReady) return;
    load().catch((err) => {
      setStatusText((err as Error).message);
    });
  }, [router.isReady]);

  useEffect(() => {
    if (!router.isReady || !selectedFloorplanId) return;
    setStoredFloorplanId(selectedFloorplanId);
    router
      .replace(
        {
          pathname: "/ha-hub",
          query: { floorplanId: selectedFloorplanId }
        },
        undefined,
        { shallow: true }
      )
      .catch(() => undefined);
  }, [selectedFloorplanId, router]);

  const sections = [
    {
      key: "floorplan-dashboard",
      title: "Floorplan Mirror",
      description: "当前户型对应的 Home Assistant 镜像仪表盘，包含户型图、房间、HA 设备和可同步场景。",
      href: mirroredDashboardUrl
    },
    { key: "areas", title: "Areas / Floors / Devices", description: "查看同步后的楼层、区域和设备归属。", href: haLinks.areas || haLinks.devices },
    { key: "automations", title: "Automations / Scripts", description: "查看同步后的脚本以及 HA 侧自动化。", href: haLinks.automations },
    { key: "scenes", title: "Scenes", description: "查看同步后的基础场景。", href: haLinks.scenes },
    { key: "history", title: "History / Activity", description: "历史曲线、日志、活动追踪。", href: haLinks.history || haLinks.logbook }
  ];

  const syncSummary = (() => {
    if (!syncStatus) return "同步状态加载中...";
    if (!syncStatus.enabled) return `HA 同步未启用: ${syncStatus.reason || "unknown"}`;
    if (syncStatus.running) return "HA 同步正在运行。";
    if (syncStatus.lastError) return `最近一次同步失败: ${syncStatus.lastError}`;
    if (syncStatus.lastReport?.counts) {
      const counts = syncStatus.lastReport.counts;
      return `上次同步: Floors ${counts.floorsCreated || 0}/${counts.floorsUpdated || 0}, Areas ${counts.areasCreated || 0}/${counts.areasUpdated || 0}, Dashboards ${counts.dashboardsCreated || 0}/${counts.dashboardsUpdated || 0}`;
    }
    return "尚未执行同步。";
  })();

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
            <h1 style={{ margin: "0.2rem 0 0.45rem", fontSize: "2rem" }}>当前户型的 HA 镜像入口</h1>
            <p style={{ margin: 0, maxWidth: 760, color: "#475569", lineHeight: 1.6 }}>
              这里不再只是静态深链。当前户型会映射为 HA Floor、Areas、Dashboard、Scenes 和 Scripts，便于直接切入 Home Assistant 页面。
            </p>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <ExternalLinkButton href={haBase} label="打开 HA 根页面" testId="ha-root-link" />
            <ExternalLinkButton href={z2mBase} label="打开 Zigbee2MQTT" testId="z2m-root-link" />
          </div>
        </header>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginTop: 20 }}>
          <div style={panelStyle}>
            <h2 style={{ margin: 0, fontSize: 16 }}>当前户型</h2>
            <div style={{ marginTop: 10, fontSize: 26, fontWeight: 900 }} data-testid="ha-current-floorplan-name">
              {selectedFloorplan?.name || "未选择户型"}
            </div>
            <div style={{ marginTop: 10 }}>
              <select
                value={selectedFloorplanId}
                onChange={(e) => setSelectedFloorplanId(e.target.value)}
                style={{
                  width: "100%",
                  padding: "0.8rem 0.9rem",
                  borderRadius: 12,
                  border: "1px solid rgba(148, 163, 184, 0.28)",
                  background: "#ffffff",
                  color: "#0f172a"
                }}
                data-testid="ha-floorplan-select"
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

          <div style={panelStyle}>
            <h2 style={{ margin: 0, fontSize: 16 }}>镜像同步状态</h2>
            <p style={{ margin: "10px 0 0", color: "#475569", lineHeight: 1.6 }} data-testid="ha-sync-status">
              {syncSummary}
            </p>
            {syncStatus?.lastSuccessAt ? (
              <p style={{ margin: "6px 0 0", color: "#64748b", fontSize: 13 }}>最近成功时间: {syncStatus.lastSuccessAt}</p>
            ) : null}
            <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
              <button
                onClick={triggerSync}
                disabled={syncing || !syncStatus?.enabled}
                style={{
                  ...linkStyle,
                  border: "1px solid #0f172a",
                  background: "#0f172a",
                  color: "#f8fafc",
                  cursor: syncing || !syncStatus?.enabled ? "not-allowed" : "pointer"
                }}
                data-testid="ha-sync-now"
              >
                {syncing ? "同步中..." : "立即同步"}
              </button>
            </div>
          </div>

          <div style={panelStyle}>
            <h2 style={{ margin: 0, fontSize: 16 }}>环境状态</h2>
            <p style={{ margin: "10px 0 0", color: "#475569", lineHeight: 1.6 }}>HA Base: {haBase || "未配置"}</p>
            <p style={{ margin: "6px 0 0", color: "#475569", lineHeight: 1.6 }}>Zigbee2MQTT Base: {z2mBase || "未配置"}</p>
            <p style={{ margin: "6px 0 0", color: "#475569", lineHeight: 1.6 }}>户型数量: {loading ? "加载中..." : floorplans.length}</p>
          </div>
        </section>

        {statusText ? (
          <section style={{ ...panelStyle, marginTop: 16 }}>
            <div style={{ color: "#b91c1c", fontSize: 13 }}>{statusText}</div>
          </section>
        ) : null}

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginTop: 20 }}>
          {sections.map((section) => (
            <article key={section.key} style={panelStyle}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{section.title}</h2>
              <p style={{ margin: "10px 0 14px", color: "#475569", lineHeight: 1.6 }}>{section.description}</p>
              <ExternalLinkButton
                href={section.href || ""}
                label={`打开 ${section.title}`}
                testId={section.key === "floorplan-dashboard" ? "ha-floorplan-dashboard-link" : `ha-hub-link-${section.key}`}
              />
            </article>
          ))}
        </section>
      </main>
    </>
  );
}
