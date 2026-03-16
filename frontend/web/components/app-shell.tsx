import Link from "next/link";
import { useRouter } from "next/router";
import type { PropsWithChildren } from "react";

import { getHaBaseUrl, getHaHubLinks, getZ2MBaseUrl } from "../lib/integrations";

const navItems = [
  { href: "/", label: "Home" },
  { href: "/floorplan", label: "Floorplan" },
  { href: "/scenes", label: "Advanced Scenes" },
  { href: "/virtual-devices", label: "Virtual Devices" },
  { href: "/ha-hub", label: "HA Hub" }
];

const shellStyle = {
  borderBottom: "1px solid rgba(148, 163, 184, 0.22)",
  background: "rgba(248, 250, 252, 0.92)",
  backdropFilter: "blur(18px)",
  position: "sticky" as const,
  top: 0,
  zIndex: 40
};

const linkStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.55rem 0.9rem",
  borderRadius: 999,
  fontSize: 14,
  fontWeight: 700,
  textDecoration: "none"
};

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function renderUtilityLink(label: string, href: string) {
  if (!href) {
    return (
      <span
        style={{
          ...linkStyle,
          background: "rgba(148, 163, 184, 0.12)",
          color: "#64748b",
          border: "1px dashed rgba(148, 163, 184, 0.35)"
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
      style={{
        ...linkStyle,
        background: "#0f172a",
        color: "#f8fafc",
        border: "1px solid rgba(15, 23, 42, 0.8)"
      }}
    >
      {label}
    </a>
  );
}

export function AppShell({ children }: PropsWithChildren) {
  const router = useRouter();
  const haBase = getHaBaseUrl();
  const z2mBase = getZ2MBaseUrl();
  const haHubLinks = getHaHubLinks();

  return (
    <>
      <style jsx global>{`
        html,
        body,
        #__next {
          margin: 0;
          min-height: 100%;
        }

        body {
          background: #f8fafc;
        }

        * {
          box-sizing: border-box;
        }
      `}</style>

      <div style={{ minHeight: "100vh" }}>
        <div style={shellStyle}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              padding: "0.9rem 1.4rem",
              flexWrap: "wrap"
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <strong style={{ fontSize: 15, letterSpacing: "0.04em" }}>Local Smart House</strong>
              <span style={{ fontSize: 12, color: "#64748b" }}>
                HA 负责通用智能家居管理，本平台负责语义、空间、模拟和智能执行。
              </span>
            </div>

            <nav style={{ display: "flex", gap: 10, flexWrap: "wrap" }} aria-label="Primary">
              {navItems.map((item) => {
                const active = isActive(router.pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    style={{
                      ...linkStyle,
                      background: active ? "#0f172a" : "rgba(255,255,255,0.78)",
                      color: active ? "#f8fafc" : "#0f172a",
                      border: active ? "1px solid #0f172a" : "1px solid rgba(148, 163, 184, 0.28)"
                    }}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {renderUtilityLink("Open HA", haHubLinks.overview || haBase)}
              {renderUtilityLink("Open Zigbee2MQTT", z2mBase)}
            </div>
          </div>
        </div>

        {children}
      </div>
    </>
  );
}
