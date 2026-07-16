import { useEffect, useMemo, useState } from "react";

import type { Capability, Device } from "../lib/device-types";

type SceneSummary = {
  id: string;
  name: string;
};

type ButtonTrigger = { type: "button"; gesture: "single" | "double" };
type StateTrigger = { type: "state"; value: "on" | "off" };
type BindingSource = {
  panelId: string;
  selector: string;
  trigger: ButtonTrigger | StateTrigger;
};
type DeviceTarget = {
  type: "device";
  deviceId: string;
  action: string;
  params?: Record<string, unknown>;
};
type SceneTarget = { type: "scene"; sceneId: string };
type BindingTarget = DeviceTarget | SceneTarget;

type SwitchBinding = {
  id: string;
  name: string;
  enabled: boolean;
  source: BindingSource;
  targets: BindingTarget[];
};

type TargetDraft = BindingTarget & { paramsText?: string };
type BindingDraft = Omit<SwitchBinding, "targets"> & { targets: TargetDraft[] };

type Props = {
  panel: Device;
  channels: Device[];
  devices: Device[];
  scenes: SceneSummary[];
  onRefreshDevices: () => Promise<void>;
};

const ENDPOINT_ORDER = ["left", "center", "right"];

export default function SwitchPanelInspector({ panel, channels, devices, scenes, onRefreshDevices }: Props) {
  const orderedChannels = useMemo(
    () =>
      [...channels].sort(
        (a, b) => ENDPOINT_ORDER.indexOf(String(a.composition?.endpoint)) - ENDPOINT_ORDER.indexOf(String(b.composition?.endpoint))
      ),
    [channels]
  );
  const endpoints = orderedChannels.map((channel) => String(channel.composition?.endpoint || "")).filter(Boolean);
  const selectorOptions = buildSelectorOptions(endpoints);
  const deviceTargets = devices.filter(
    (device) => device.composition?.role !== "panel" && Array.isArray(device.capabilities) && device.capabilities.length > 0
  );

  const [bindings, setBindings] = useState<SwitchBinding[]>([]);
  const [loadingBindings, setLoadingBindings] = useState(false);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState<BindingDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [channelNames, setChannelNames] = useState<Record<string, string>>({});
  const [channelBusy, setChannelBusy] = useState<Record<string, string>>({});

  useEffect(() => {
    setChannelNames(Object.fromEntries(orderedChannels.map((channel) => [channel.id, channel.name])));
  }, [panel.id, orderedChannels.map((channel) => `${channel.id}:${channel.name}`).join("|")]);

  useEffect(() => {
    void refreshBindings();
    setDraft(null);
    setEditingId(null);
  }, [panel.id]);

  async function refreshBindings() {
    setLoadingBindings(true);
    try {
      const resp = await fetch(`/api/switch-bindings?panelId=${encodeURIComponent(panel.id)}`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.reason || data?.error || "加载软件绑定失败");
      setBindings(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setLoadingBindings(false);
    }
  }

  function startCreate() {
    const selector = endpoints[0] || "left";
    setEditingId(null);
    setDraft({
      id: createBindingId(panel.id),
      name: `${endpointLabel(selector)} 单击绑定`,
      enabled: true,
      source: { panelId: panel.id, selector, trigger: { type: "button", gesture: "single" } },
      targets: []
    });
    setStatus("");
  }

  function startEdit(binding: SwitchBinding) {
    setEditingId(binding.id);
    setDraft({
      ...structuredClone(binding),
      targets: binding.targets.map((target) => ({
        ...structuredClone(target),
        ...(target.type === "device" ? { paramsText: JSON.stringify(target.params || {}) } : {})
      }))
    });
    setStatus("");
  }

  function updateTriggerType(type: "button" | "state") {
    setDraft((current) => {
      if (!current) return current;
      const selector = type === "state" && !endpoints.includes(current.source.selector) ? endpoints[0] || "left" : current.source.selector;
      return {
        ...current,
        source: {
          ...current.source,
          selector,
          trigger: type === "button" ? { type: "button", gesture: "single" } : { type: "state", value: "on" }
        }
      };
    });
  }

  function addTarget(type: "device" | "scene") {
    setDraft((current) => {
      if (!current) return current;
      if (type === "scene") {
        return { ...current, targets: [...current.targets, { type: "scene", sceneId: scenes[0]?.id || "" }] };
      }
      const device = deviceTargets[0];
      return {
        ...current,
        targets: [
          ...current.targets,
          {
            type: "device",
            deviceId: device?.id || "",
            action: device?.capabilities?.[0]?.action || "",
            paramsText: "{}"
          }
        ]
      };
    });
  }

  function replaceTarget(index: number, next: TargetDraft) {
    setDraft((current) => {
      if (!current) return current;
      return { ...current, targets: current.targets.map((target, targetIndex) => (targetIndex === index ? next : target)) };
    });
  }

  function moveTarget(index: number, direction: -1 | 1) {
    setDraft((current) => {
      if (!current) return current;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.targets.length) return current;
      const targets = [...current.targets];
      [targets[index], targets[nextIndex]] = [targets[nextIndex], targets[index]];
      return { ...current, targets };
    });
  }

  async function saveBinding() {
    if (!draft) return;
    setSaving(true);
    setStatus("正在保存绑定…");
    try {
      const targets = draft.targets.map((target) => {
        if (target.type === "scene") return { type: "scene", sceneId: target.sceneId };
        let params: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(target.paramsText || "{}");
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          if (Object.keys(parsed).length) params = parsed;
        } catch (_err) {
          throw new Error(`第 ${draft.targets.indexOf(target) + 1} 个目标的参数必须是 JSON 对象`);
        }
        return {
          type: "device",
          deviceId: target.deviceId,
          action: target.action,
          ...(params ? { params } : {})
        };
      });
      const payload = { ...draft, targets };
      const url = editingId ? `/api/switch-bindings/${encodeURIComponent(editingId)}` : "/api/switch-bindings";
      const resp = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.reason || data?.message || data?.error || "保存绑定失败");
      await refreshBindings();
      setDraft(null);
      setEditingId(null);
      setStatus("绑定已保存，规则引擎已立即生效");
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteBinding(binding: SwitchBinding) {
    if (!window.confirm(`确认删除“${binding.name}”吗？`)) return;
    setStatus("正在删除绑定…");
    try {
      const resp = await fetch(`/api/switch-bindings/${encodeURIComponent(binding.id)}`, { method: "DELETE" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.reason || data?.error || "删除绑定失败");
      if (editingId === binding.id) {
        setDraft(null);
        setEditingId(null);
      }
      await refreshBindings();
      setStatus("绑定已删除");
    } catch (err) {
      setStatus((err as Error).message);
    }
  }

  async function saveChannelName(channel: Device) {
    const name = String(channelNames[channel.id] || "").trim();
    if (!name) {
      setStatus("硬接灯名称不能为空");
      return;
    }
    setChannelBusy((current) => ({ ...current, [channel.id]: "name" }));
    setStatus("正在保存硬接灯名称…");
    try {
      const resp = await fetch(`/api/device-overrides/${encodeURIComponent(channel.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: channel.id, name })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.reason || data?.error || "保存名称失败");
      setStatus("硬接灯名称已保存，设备适配器将在约 1–2 秒内应用");
      window.setTimeout(() => void onRefreshDevices(), 1500);
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setChannelBusy((current) => ({ ...current, [channel.id]: "" }));
    }
  }

  async function changeOperationMode(channel: Device, mode: "control_relay" | "decoupled") {
    const currentMode = channel.traits?.switch?.operation_mode;
    if (mode === currentMode) return;
    if (
      mode === "decoupled" &&
      !window.confirm("解耦后，物理按键不再直接切换这一路继电器。请确认已有可用的软件绑定，并保留恢复 control_relay 的路径。")
    ) {
      return;
    }
    setChannelBusy((current) => ({ ...current, [channel.id]: mode }));
    setStatus(`正在把${endpointLabel(channel.composition?.endpoint)}切换为${modeLabel(mode)}…`);
    try {
      const resp = await fetch(`/api/devices/${encodeURIComponent(channel.id)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_operation_mode", params: { mode } })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.reason || data?.error || "模式切换失败");

      const readBack = await waitForOperationMode(channel.id, mode);
      await onRefreshDevices();
      setStatus(
        readBack
          ? `${endpointLabel(channel.composition?.endpoint)}已切换为${modeLabel(mode)}，设备状态回读一致`
          : "指令已发送，但设备尚未回报新模式；请稍后刷新并核对 Zigbee2MQTT"
      );
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setChannelBusy((current) => ({ ...current, [channel.id]: "" }));
    }
  }

  return (
    <section style={sectionStyle} data-testid="switch-panel-inspector">
      <div style={sectionHeadingStyle}>
        <div>
          <h4 style={{ margin: 0, fontSize: 14 }}>开关面板与灯路</h4>
          <p style={hintStyle}>面板只布一个点；下方每一路代表真实继电器与硬接线灯具。</p>
        </div>
        <span style={countStyle}>{orderedChannels.length} 路</span>
      </div>

      <div style={{ borderTop: "1px solid #e2e8f0" }}>
        {orderedChannels.map((channel) => {
          const endpoint = String(channel.composition?.endpoint || "");
          const state = channel.traits?.switch?.state === "on" ? "on" : "off";
          const operationMode = String(channel.traits?.switch?.operation_mode || "");
          const supportsMode = channel.capabilities?.some((capability) => capability.action === "set_operation_mode");
          return (
            <div key={channel.id} style={channelRowStyle} data-testid={`switch-channel-${endpoint}`}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ ...stateDotStyle, background: state === "on" ? "#f59e0b" : "#94a3b8" }} />
                <strong style={{ minWidth: 36, fontSize: 13 }}>{endpointLabel(endpoint)}</strong>
                <span style={{ fontSize: 12, color: state === "on" ? "#92400e" : "#64748b" }}>{state === "on" ? "继电器已通" : "继电器已断"}</span>
              </div>
              <label style={compactLabelStyle}>硬接灯名称</label>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 6 }}>
                <input
                  value={channelNames[channel.id] || ""}
                  onChange={(event) => setChannelNames((current) => ({ ...current, [channel.id]: event.target.value }))}
                  style={inputStyle}
                  data-testid={`switch-channel-name-${endpoint}`}
                />
                <button
                  type="button"
                  style={smallButtonStyle}
                  onClick={() => void saveChannelName(channel)}
                  disabled={Boolean(channelBusy[channel.id])}
                >
                  保存
                </button>
              </div>
              <label style={compactLabelStyle}>物理按键工作模式</label>
              {supportsMode ? (
                <select
                  value={operationMode}
                  onChange={(event) => void changeOperationMode(channel, event.target.value as "control_relay" | "decoupled")}
                  style={inputStyle}
                  disabled={Boolean(channelBusy[channel.id])}
                  data-testid={`switch-channel-mode-${endpoint}`}
                >
                  {!operationMode && <option value="">等待设备回报</option>}
                  <option value="control_relay">直控继电器（默认）</option>
                  <option value="decoupled">解耦（仅发按键事件）</option>
                </select>
              ) : (
                <p style={hintStyle}>该通道未暴露工作模式设置。</p>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ ...sectionHeadingStyle, borderTop: "1px solid #cbd5e1", marginTop: 4, paddingTop: 14 }}>
        <div>
          <h4 style={{ margin: 0, fontSize: 14 }}>软件绑定</h4>
          <p style={hintStyle}>一个按键动作可以按顺序控制多个设备或场景。</p>
        </div>
        <button type="button" style={smallButtonStyle} onClick={startCreate} data-testid="switch-binding-add">
          新增绑定
        </button>
      </div>

      {loadingBindings ? (
        <p style={hintStyle}>正在加载绑定…</p>
      ) : bindings.length ? (
        <div style={{ borderTop: "1px solid #e2e8f0" }}>
          {bindings.map((binding) => (
            <div key={binding.id} style={bindingRowStyle} data-testid={`switch-binding-${binding.id}`}>
              <div style={{ minWidth: 0 }}>
                <strong style={{ fontSize: 13 }}>{binding.name}</strong>
                <p style={{ ...hintStyle, overflowWrap: "anywhere" }}>
                  {sourceLabel(binding.source)} → {binding.targets.map((target) => targetLabel(target, devices, scenes)).join("，")}
                </p>
              </div>
              <div style={{ display: "flex", gap: 5 }}>
                <button type="button" style={microButtonStyle} onClick={() => startEdit(binding)}>
                  编辑
                </button>
                <button type="button" style={microDangerButtonStyle} onClick={() => void deleteBinding(binding)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p style={emptyStyle}>还没有软件绑定。直控模式下硬接灯仍可正常使用。</p>
      )}

      {draft && (
        <div style={editorStyle} data-testid="switch-binding-editor">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <strong style={{ fontSize: 13 }}>{editingId ? "编辑绑定" : "新建绑定"}</strong>
            <button type="button" style={microButtonStyle} onClick={() => setDraft(null)}>
              关闭
            </button>
          </div>

          <label style={compactLabelStyle}>绑定名称</label>
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} style={inputStyle} />

          <div style={twoColumnStyle}>
            <div>
              <label style={compactLabelStyle}>触发来源</label>
              <select value={draft.source.trigger.type} onChange={(event) => updateTriggerType(event.target.value as "button" | "state")} style={inputStyle}>
                <option value="button">物理按键事件</option>
                <option value="state">继电器状态变化</option>
              </select>
            </div>
            <div>
              <label style={compactLabelStyle}>按键 / 灯路</label>
              <select
                value={draft.source.selector}
                onChange={(event) => setDraft({ ...draft, source: { ...draft.source, selector: event.target.value } })}
                style={inputStyle}
              >
                {(draft.source.trigger.type === "state" ? selectorOptions.filter((item) => endpoints.includes(item.value)) : selectorOptions).map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <label style={compactLabelStyle}>{draft.source.trigger.type === "button" ? "手势" : "变为"}</label>
          {draft.source.trigger.type === "button" ? (
            <select
              value={draft.source.trigger.gesture}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  source: { ...draft.source, trigger: { type: "button", gesture: event.target.value as "single" | "double" } }
                })
              }
              style={inputStyle}
            >
              <option value="single">单击</option>
              <option value="double">双击</option>
            </select>
          ) : (
            <select
              value={draft.source.trigger.value}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  source: { ...draft.source, trigger: { type: "state", value: event.target.value as "on" | "off" } }
                })
              }
              style={inputStyle}
            >
              <option value="on">开启</option>
              <option value="off">关闭</option>
            </select>
          )}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12 }}>
            <label style={{ ...compactLabelStyle, margin: 0 }}>执行目标（按顺序）</label>
            <div style={{ display: "flex", gap: 5 }}>
              <button type="button" style={microButtonStyle} onClick={() => addTarget("device")}>
                + 设备
              </button>
              <button type="button" style={microButtonStyle} onClick={() => addTarget("scene")} disabled={!scenes.length}>
                + 场景
              </button>
            </div>
          </div>

          {draft.targets.map((target, index) => (
            <div key={`${index}-${target.type}`} style={targetStyle} data-testid={`switch-binding-target-${index}`}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>#{index + 1}</span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button type="button" style={microButtonStyle} onClick={() => moveTarget(index, -1)} disabled={index === 0} aria-label="上移目标">
                    ↑
                  </button>
                  <button
                    type="button"
                    style={microButtonStyle}
                    onClick={() => moveTarget(index, 1)}
                    disabled={index === draft.targets.length - 1}
                    aria-label="下移目标"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    style={microDangerButtonStyle}
                    onClick={() => setDraft({ ...draft, targets: draft.targets.filter((_, targetIndex) => targetIndex !== index) })}
                    aria-label="删除目标"
                  >
                    ×
                  </button>
                </div>
              </div>
              <select
                value={target.type}
                onChange={(event) => {
                  if (event.target.value === "scene") {
                    replaceTarget(index, { type: "scene", sceneId: scenes[0]?.id || "" });
                  } else {
                    const device = deviceTargets[0];
                    replaceTarget(index, {
                      type: "device",
                      deviceId: device?.id || "",
                      action: device?.capabilities?.[0]?.action || "",
                      paramsText: "{}"
                    });
                  }
                }}
                style={inputStyle}
              >
                <option value="device">设备动作</option>
                <option value="scene">场景</option>
              </select>
              {target.type === "scene" ? (
                <select value={target.sceneId} onChange={(event) => replaceTarget(index, { ...target, sceneId: event.target.value })} style={inputStyle}>
                  {scenes.map((scene) => (
                    <option key={scene.id} value={scene.id}>
                      {scene.name}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <select
                    value={target.deviceId}
                    onChange={(event) => {
                      const device = deviceTargets.find((item) => item.id === event.target.value);
                      replaceTarget(index, {
                        ...target,
                        deviceId: event.target.value,
                        action: device?.capabilities?.[0]?.action || "",
                        paramsText: "{}"
                      });
                    }}
                    style={inputStyle}
                  >
                    {deviceTargets.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={target.action}
                    onChange={(event) => replaceTarget(index, { ...target, action: event.target.value, paramsText: "{}" })}
                    style={inputStyle}
                  >
                    {capabilitiesFor(deviceTargets, target.deviceId).map((capability) => (
                      <option key={capability.action} value={capability.action}>
                        {capability.description || capability.action}
                      </option>
                    ))}
                  </select>
                  {capabilityFor(deviceTargets, target.deviceId, target.action)?.parameters?.length ? (
                    <>
                      <label style={compactLabelStyle}>参数 JSON</label>
                      <input
                        value={target.paramsText || "{}"}
                        onChange={(event) => replaceTarget(index, { ...target, paramsText: event.target.value })}
                        style={{ ...inputStyle, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                        placeholder='例如 {"brightness":80}'
                      />
                    </>
                  ) : null}
                </>
              )}
            </div>
          ))}

          {!draft.targets.length && <p style={emptyStyle}>至少添加一个设备动作或场景。</p>}
          <label style={{ ...compactLabelStyle, display: "flex", alignItems: "center", gap: 7 }}>
            <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
            启用此绑定
          </label>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => void saveBinding()}
            disabled={saving || !draft.name.trim() || !draft.targets.length}
            data-testid="switch-binding-save"
          >
            {saving ? "保存中…" : "保存并立即生效"}
          </button>
        </div>
      )}

      {status && <p style={statusStyle}>{status}</p>}
    </section>
  );
}

async function waitForOperationMode(deviceId: string, expectedMode: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    const resp = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`);
    if (!resp.ok) continue;
    const device = await resp.json().catch(() => ({}));
    if (device?.traits?.switch?.operation_mode === expectedMode) return true;
  }
  return false;
}

function buildSelectorOptions(endpoints: string[]) {
  const items = endpoints.map((endpoint) => ({ value: endpoint, label: endpointLabel(endpoint) }));
  if (endpoints.length === 2) items.push({ value: "both", label: "左右组合键" });
  if (endpoints.length >= 3) {
    items.push(
      { value: "left_center", label: "左 + 中组合键" },
      { value: "left_right", label: "左 + 右组合键" },
      { value: "center_right", label: "中 + 右组合键" },
      { value: "all", label: "三键组合" }
    );
  }
  return items;
}

function endpointLabel(value?: string) {
  return ({ left: "左路", center: "中路", right: "右路", both: "左右组合键", all: "三键组合" } as Record<string, string>)[String(value)] || String(value || "通道");
}

function modeLabel(value: string) {
  return value === "decoupled" ? "解耦模式" : "直控继电器模式";
}

function sourceLabel(source: BindingSource) {
  const trigger = source.trigger.type === "button" ? (source.trigger.gesture === "double" ? "双击" : "单击") : `继电器变为${source.trigger.value === "on" ? "开" : "关"}`;
  return `${endpointLabel(source.selector)} ${trigger}`;
}

function targetLabel(target: BindingTarget, devices: Device[], scenes: SceneSummary[]) {
  if (target.type === "scene") return `场景「${scenes.find((scene) => scene.id === target.sceneId)?.name || target.sceneId}」`;
  const device = devices.find((item) => item.id === target.deviceId);
  return `${device?.name || target.deviceId}.${target.action}`;
}

function capabilitiesFor(devices: Device[], deviceId: string): Capability[] {
  return devices.find((device) => device.id === deviceId)?.capabilities || [];
}

function capabilityFor(devices: Device[], deviceId: string, action: string) {
  return capabilitiesFor(devices, deviceId).find((capability) => capability.action === action);
}

function createBindingId(panelId: string) {
  const stem = panelId.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(-36) || "panel";
  return `switch_${stem}_${Date.now().toString(36)}`;
}

const sectionStyle: React.CSSProperties = {
  marginTop: 14,
  paddingTop: 12,
  borderTop: "1px solid #e2e8f0"
};

const sectionHeadingStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 10,
  marginBottom: 10
};

const channelRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "11px 0",
  borderBottom: "1px solid #e2e8f0"
};

const bindingRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 8,
  alignItems: "center",
  padding: "10px 0",
  borderBottom: "1px solid #e2e8f0"
};

const editorStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  border: "1px solid #94a3b8",
  borderRadius: 12,
  background: "#f8fafc"
};

const targetStyle: React.CSSProperties = {
  marginTop: 8,
  padding: 9,
  borderLeft: "3px solid #64748b",
  background: "white"
};

const twoColumnStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8
};

const compactLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 700,
  color: "#475569",
  marginTop: 8
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 8px",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  background: "white",
  fontSize: 12
};

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 12,
  padding: "9px 12px",
  borderRadius: 9,
  border: 0,
  background: "#0f172a",
  color: "white",
  fontWeight: 700,
  cursor: "pointer"
};

const smallButtonStyle: React.CSSProperties = {
  padding: "6px 9px",
  borderRadius: 8,
  border: "1px solid #64748b",
  background: "white",
  color: "#0f172a",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer"
};

const microButtonStyle: React.CSSProperties = {
  padding: "3px 7px",
  borderRadius: 6,
  border: "1px solid #94a3b8",
  background: "white",
  color: "#334155",
  fontSize: 11,
  cursor: "pointer"
};

const microDangerButtonStyle: React.CSSProperties = {
  ...microButtonStyle,
  borderColor: "#fca5a5",
  color: "#b91c1c"
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  margin: "4px 0 0",
  lineHeight: 1.5
};

const emptyStyle: React.CSSProperties = {
  margin: "8px 0",
  padding: "9px 10px",
  borderLeft: "3px solid #cbd5e1",
  background: "#f8fafc",
  color: "#64748b",
  fontSize: 11,
  lineHeight: 1.5
};

const statusStyle: React.CSSProperties = {
  margin: "10px 0 0",
  padding: "8px 10px",
  borderRadius: 8,
  background: "#eff6ff",
  color: "#1e3a8a",
  fontSize: 11,
  lineHeight: 1.5
};

const countStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: "3px 7px",
  borderRadius: 999,
  background: "#e2e8f0",
  color: "#334155",
  fontSize: 11,
  fontWeight: 700
};

const stateDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  boxShadow: "0 0 0 3px rgba(148, 163, 184, 0.18)"
};
