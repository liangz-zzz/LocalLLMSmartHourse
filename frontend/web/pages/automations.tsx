import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/router";

type CapabilityParam = {
  name: string;
  type: "boolean" | "number" | "string" | "enum";
  minimum?: number;
  maximum?: number;
  enum?: string[];
  required?: boolean;
};

type Capability = {
  action: string;
  description?: string;
  parameters?: CapabilityParam[];
};

type Device = {
  id: string;
  name: string;
  placement?: { room?: string; zone?: string; floor?: string; mount?: string; description?: string };
  capabilities?: Capability[];
};

type SceneSummary = { id: string; name: string; description?: string };

type Operator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

type WaitFor = {
  traitPath: string;
  operator: Operator;
  value: any;
  timeoutMs: number;
  pollMs?: number;
  on_timeout?: "abort";
};

type Trigger =
  | { type: "device"; deviceId?: string; traitPath?: string; operator?: Operator; value?: any; changed?: boolean }
  | { type: "time"; at: string[] }
  | { type: "interval"; everyMs: number };

type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { time: { after?: string; before?: string } }
  | { deviceId: string; traitPath: string; operator?: Operator; value?: any; equals?: any };

type AutomationAction =
  | { type: "scene"; sceneId: string }
  | { type: "device"; deviceId: string; action: string; params?: Record<string, any>; wait_for?: WaitFor };

type Automation = {
  id: string;
  name?: string;
  enabled?: boolean;
  trigger: Trigger;
  when?: Condition;
  forMs?: number;
  cooldownMs?: number;
  then: AutomationAction[];
};

const pageBg = "linear-gradient(135deg, #0b1221 0%, #172554 50%, #0e7490 100%)";

const panelStyle: CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  borderRadius: 16,
  border: "1px solid rgba(255,255,255,0.08)",
  padding: "1rem"
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.55rem 0.7rem",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(0,0,0,0.25)",
  color: "#e8edf7"
};

const labelStyle: CSSProperties = { fontSize: 13, opacity: 0.8 };

const primaryButtonStyle: CSSProperties = {
  background: "#22c55e",
  border: "none",
  color: "#0b1221",
  padding: "0.55rem 0.8rem",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 800
};

const secondaryButtonStyle: CSSProperties = {
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#e8edf7",
  padding: "0.55rem 0.8rem",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 700
};

const dangerButtonStyle: CSSProperties = {
  background: "rgba(239, 68, 68, 0.15)",
  border: "1px solid rgba(239, 68, 68, 0.35)",
  color: "#fecaca",
  padding: "0.55rem 0.8rem",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 800
};

const monoStyle: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
};

function coerceJsonValue(raw: string) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toDisplayValue(value: any) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isPlainObject(v: any) {
  return v && typeof v === "object" && !Array.isArray(v);
}

export default function AutomationsPage() {
  const router = useRouter();
  const prefillDeviceId = typeof router.query.deviceId === "string" ? router.query.deviceId : "";

  const [automationList, setAutomationList] = useState<Automation[]>([]);
  const [sceneList, setSceneList] = useState<SceneSummary[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [draft, setDraft] = useState<Automation | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [details, setDetails] = useState<string[]>([]);

  // when editor
  const [whenMode, setWhenMode] = useState<"none" | "form" | "advanced">("none");
  const [whenTimeAfter, setWhenTimeAfter] = useState("");
  const [whenTimeBefore, setWhenTimeBefore] = useState("");
  const [whenConds, setWhenConds] = useState<Array<{ deviceId: string; traitPath: string; operator: Operator; value: any }>>([]);
  const [whenJson, setWhenJson] = useState<string>("");

  const deviceMap = useMemo(() => {
    const map: Record<string, Device> = {};
    devices.forEach((d) => (map[d.id] = d));
    return map;
  }, [devices]);

  const refreshLists = async () => {
    setLoading(true);
    setStatus("");
    setDetails([]);
    try {
      const [autosRes, scenesRes, devicesRes] = await Promise.all([fetch("/api/automations"), fetch("/api/scenes"), fetch("/api/devices")]);
      const autosJson = await autosRes.json();
      const scenesJson = await scenesRes.json();
      const devicesJson = await devicesRes.json();
      setAutomationList(autosJson.items || []);
      setSceneList(scenesJson.items || []);
      setDevices(devicesJson.items || []);
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadAutomation = async (id: string) => {
    setLoading(true);
    setStatus("");
    setDetails([]);
    try {
      const resp = await fetch(`/api/automations/${encodeURIComponent(id)}`);
      const data = await resp.json();
      if (!resp.ok) {
        setStatus(data?.error || "加载失败");
        return;
      }
      setDraft(data);
      hydrateWhenEditor(data.when);
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const hydrateWhenEditor = (when?: Condition) => {
    if (!when) {
      setWhenMode("none");
      setWhenTimeAfter("");
      setWhenTimeBefore("");
      setWhenConds([]);
      setWhenJson("");
      return;
    }

    const parseDeviceCond = (c: any) => {
      if (!isPlainObject(c)) return null;
      if (typeof c.deviceId !== "string" || typeof c.traitPath !== "string") return null;
      const operator = (c.operator || "eq") as Operator;
      if (!["eq", "neq", "gt", "gte", "lt", "lte"].includes(operator)) return null;
      const value = Object.prototype.hasOwnProperty.call(c, "value") ? c.value : c.equals;
      if (value === undefined) return null;
      return { deviceId: c.deviceId, traitPath: c.traitPath, operator, value };
    };

    // time-only
    if (isPlainObject((when as any).time)) {
      const time = (when as any).time;
      setWhenMode("form");
      setWhenTimeAfter(String(time.after || ""));
      setWhenTimeBefore(String(time.before || ""));
      setWhenConds([]);
      setWhenJson("");
      return;
    }

    // atomic device condition
    const atomic = parseDeviceCond(when);
    if (atomic) {
      setWhenMode("form");
      setWhenTimeAfter("");
      setWhenTimeBefore("");
      setWhenConds([atomic]);
      setWhenJson("");
      return;
    }

    // all[] with time/device conditions
    if (Array.isArray((when as any).all)) {
      const items = (when as any).all;
      const parsedConds: Array<{ deviceId: string; traitPath: string; operator: Operator; value: any }> = [];
      let after = "";
      let before = "";
      for (const item of items) {
        if (isPlainObject(item?.time)) {
          after = String(item.time.after || "");
          before = String(item.time.before || "");
          continue;
        }
        const parsed = parseDeviceCond(item);
        if (parsed) {
          parsedConds.push(parsed);
          continue;
        }
        // unsupported nesting => advanced
        setWhenMode("advanced");
        setWhenJson(JSON.stringify(when, null, 2));
        setWhenTimeAfter("");
        setWhenTimeBefore("");
        setWhenConds([]);
        return;
      }
      setWhenMode("form");
      setWhenTimeAfter(after);
      setWhenTimeBefore(before);
      setWhenConds(parsedConds);
      setWhenJson("");
      return;
    }

    // fallback
    setWhenMode("advanced");
    setWhenJson(JSON.stringify(when, null, 2));
    setWhenTimeAfter("");
    setWhenTimeBefore("");
    setWhenConds([]);
  };

  const buildWhen = (): Condition | undefined => {
    if (whenMode === "none") return undefined;
    if (whenMode === "advanced") {
      const raw = whenJson.trim();
      if (!raw) return undefined;
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new Error(`when JSON 解析失败: ${(err as Error).message}`);
      }
    }

    const hasTime = Boolean(whenTimeAfter.trim() || whenTimeBefore.trim());
    const timeCond = hasTime ? { time: { ...(whenTimeAfter.trim() ? { after: whenTimeAfter.trim() } : {}), ...(whenTimeBefore.trim() ? { before: whenTimeBefore.trim() } : {}) } } : null;
    const deviceConds = whenConds
      .map((c) => ({
        deviceId: String(c.deviceId || "").trim(),
        traitPath: String(c.traitPath || "").trim(),
        operator: c.operator || "eq",
        value: c.value
      }))
      .filter((c) => c.deviceId && c.traitPath);

    if (timeCond && deviceConds.length === 0) return timeCond as any;
    const all = [...(timeCond ? [timeCond as any] : []), ...deviceConds];
    if (all.length === 0) return undefined;
    if (all.length === 1) return all[0] as any;
    return { all: all as any } as any;
  };

  useEffect(() => {
    refreshLists();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    loadAutomation(selectedId);
  }, [selectedId]);

  const startNew = () => {
    const trigger: Trigger =
      prefillDeviceId || devices.length
        ? { type: "device", deviceId: prefillDeviceId || devices[0]?.id || "", traitPath: "traits.raw.state", operator: "eq", value: "on", changed: true }
        : { type: "interval", everyMs: 60_000 };
    setSelectedId("");
    setDraft({ id: "", name: "", enabled: true, trigger, then: [] });
    hydrateWhenEditor(undefined);
    setStatus("");
    setDetails([]);
  };

  const moveAction = (index: number, delta: number) => {
    if (!draft) return;
    const next = [...draft.then];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const tmp = next[index];
    next[index] = next[target];
    next[target] = tmp;
    setDraft({ ...draft, then: next });
  };

  const removeAction = (index: number) => {
    if (!draft) return;
    setDraft({ ...draft, then: draft.then.filter((_a, i) => i !== index) });
  };

  const addSceneAction = () => {
    if (!draft) return;
    setDraft({ ...draft, then: [...draft.then, { type: "scene", sceneId: sceneList[0]?.id || "" }] });
  };

  const addDeviceAction = () => {
    if (!draft) return;
    const fallbackDeviceId = prefillDeviceId || devices[0]?.id || "";
    const caps = deviceMap[fallbackDeviceId]?.capabilities || [];
    setDraft({
      ...draft,
      then: [
        ...draft.then,
        {
          type: "device",
          deviceId: fallbackDeviceId,
          action: caps[0]?.action || "",
          params: {}
        }
      ]
    });
  };

  const save = async () => {
    if (!draft) return;
    setLoading(true);
    setStatus("保存中...");
    setDetails([]);
    try {
      const when = buildWhen();
      const payload: Automation = { ...draft, when };
      const isNew = !selectedId;
      const url = isNew ? "/api/automations" : `/api/automations/${encodeURIComponent(selectedId)}`;
      const method = isNew ? "POST" : "PUT";
      const resp = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok) {
        setStatus(data?.reason || data?.error || "保存失败");
        setDetails(data?.details || []);
        return;
      }
      await refreshLists();
      setStatus("已保存");
      setSelectedId(data.id);
      setDraft(data);
      hydrateWhenEditor(data.when);
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const deleteAutomation = async () => {
    if (!selectedId) return;
    const ok = window.confirm(`确认删除联动 ${selectedId}？`);
    if (!ok) return;
    setLoading(true);
    setStatus("删除中...");
    setDetails([]);
    try {
      const resp = await fetch(`/api/automations/${encodeURIComponent(selectedId)}`, { method: "DELETE" });
      const data = await resp.json();
      if (!resp.ok) {
        setStatus(data?.reason || data?.error || "删除失败");
        setDetails(data?.details || []);
        return;
      }
      setStatus("已删除");
      setSelectedId("");
      setDraft(null);
      await refreshLists();
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const actionEditor = (action: AutomationAction, index: number) => {
    if (!draft) return null;
    const updateAction = (patch: Partial<AutomationAction>) => {
      const next = [...draft.then];
      next[index] = { ...(next[index] as any), ...(patch as any) };
      setDraft({ ...draft, then: next });
    };

    const setActionType = (type: "scene" | "device") => {
      if (type === action.type) return;
      const next = [...draft.then];
      if (type === "scene") next[index] = { type: "scene", sceneId: sceneList[0]?.id || "" };
      else {
        const fallbackDeviceId = prefillDeviceId || devices[0]?.id || "";
        const caps = deviceMap[fallbackDeviceId]?.capabilities || [];
        next[index] = { type: "device", deviceId: fallbackDeviceId, action: caps[0]?.action || "", params: {} };
      }
      setDraft({ ...draft, then: next });
    };

    return (
      <div
        key={index}
        style={{
          padding: "0.9rem",
          borderRadius: 14,
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(16, 24, 40, 0.35)",
          display: "flex",
          flexDirection: "column",
          gap: 10
        }}
        data-testid={`automation-action-${index}`}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ fontWeight: 900, opacity: 0.85 }}>Then {index + 1}</span>
            <select
              value={action.type}
              onChange={(e) => setActionType(e.target.value as any)}
              style={{ ...inputStyle, width: 160 }}
              data-testid={`action-type-${index}`}
            >
              <option value="scene">scene</option>
              <option value="device">device</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={secondaryButtonStyle} onClick={() => moveAction(index, -1)} disabled={index === 0}>
              上移
            </button>
            <button style={secondaryButtonStyle} onClick={() => moveAction(index, +1)} disabled={index === draft.then.length - 1}>
              下移
            </button>
            <button style={dangerButtonStyle} onClick={() => removeAction(index)}>
              删除
            </button>
          </div>
        </div>

        {action.type === "scene" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
            <label style={labelStyle}>sceneId</label>
            <select
              value={action.sceneId}
              onChange={(e) => updateAction({ sceneId: e.target.value } as any)}
              style={inputStyle}
              data-testid={`action-sceneId-${index}`}
            >
              <option value="">选择场景...</option>
              {sceneList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.id})
                </option>
              ))}
            </select>
          </div>
        )}

        {action.type === "device" && (
          <AutomationDeviceActionEditor
            index={index}
            action={action}
            devices={devices}
            deviceMap={deviceMap}
            onChange={(next) => updateAction(next as any)}
          />
        )}
      </div>
    );
  };

  const renderTrigger = () => {
    if (!draft) return null;
    const trig = draft.trigger;
    const setTriggerType = (type: Trigger["type"]) => {
      if (type === trig.type) return;
      if (type === "device") {
        setDraft({
          ...draft,
          trigger: { type: "device", deviceId: prefillDeviceId || devices[0]?.id || "", traitPath: "", operator: "eq", value: "", changed: false }
        });
      } else if (type === "time") {
        setDraft({ ...draft, trigger: { type: "time", at: ["23:00"] } });
      } else {
        setDraft({ ...draft, trigger: { type: "interval", everyMs: 60_000 } });
      }
    };

    return (
      <div style={{ ...panelStyle, background: "rgba(0,0,0,0.16)" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Trigger</h3>
        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle}>type</label>
            <select value={trig.type} onChange={(e) => setTriggerType(e.target.value as any)} style={inputStyle} data-testid="trigger-type">
              <option value="device">device</option>
              <option value="time">time</option>
              <option value="interval">interval</option>
            </select>
          </div>
          <div />
        </div>

        {trig.type === "device" && (
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>deviceId</label>
              <select
                value={trig.deviceId || ""}
                onChange={(e) => setDraft({ ...draft, trigger: { ...trig, deviceId: e.target.value } })}
                style={inputStyle}
                data-testid="trigger-deviceId"
              >
                <option value="">选择设备...</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.id})
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.85, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={Boolean(trig.changed)}
                  onChange={(e) => setDraft({ ...draft, trigger: { ...trig, changed: e.target.checked } })}
                />
                changed
              </label>
            </div>
            <div>
              <label style={labelStyle}>traitPath</label>
              <input
                value={trig.traitPath || ""}
                onChange={(e) => setDraft({ ...draft, trigger: { ...trig, traitPath: e.target.value } })}
                style={inputStyle}
                placeholder="例如: traits.raw.state"
                data-testid="trigger-traitPath"
              />
            </div>
            <div>
              <label style={labelStyle}>operator</label>
              <select
                value={trig.operator || "eq"}
                onChange={(e) => setDraft({ ...draft, trigger: { ...trig, operator: e.target.value as any } })}
                style={inputStyle}
                data-testid="trigger-operator"
              >
                <option value="eq">eq</option>
                <option value="neq">neq</option>
                <option value="gt">gt</option>
                <option value="gte">gte</option>
                <option value="lt">lt</option>
                <option value="lte">lte</option>
              </select>
            </div>
            <div style={{ gridColumn: "1 / span 2" }}>
              <label style={labelStyle}>value</label>
              <input
                value={toDisplayValue(trig.value)}
                onChange={(e) => setDraft({ ...draft, trigger: { ...trig, value: coerceJsonValue(e.target.value) } })}
                style={inputStyle}
                placeholder='例如: on / 0 / "off"'
                data-testid="trigger-value"
              />
            </div>
          </div>
        )}

        {trig.type === "time" && (
          <div style={{ marginTop: 12 }}>
            <label style={labelStyle}>at (HH:MM, 逗号分隔)</label>
            <input
              value={(trig.at || []).join(", ")}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  trigger: { type: "time", at: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }
                })
              }
              style={inputStyle}
              placeholder="23:00, 07:30"
              data-testid="trigger-at"
            />
          </div>
        )}

        {trig.type === "interval" && (
          <div style={{ marginTop: 12, maxWidth: 360 }}>
            <label style={labelStyle}>everyMs</label>
            <input
              type="number"
              value={trig.everyMs}
              onChange={(e) => setDraft({ ...draft, trigger: { type: "interval", everyMs: Number(e.target.value) } })}
              style={inputStyle}
              data-testid="trigger-everyMs"
            />
          </div>
        )}
      </div>
    );
  };

  const renderWhen = () => {
    if (!draft) return null;
    return (
      <div style={{ ...panelStyle, background: "rgba(0,0,0,0.16)" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>When（可选）</h3>
        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
          <select value={whenMode} onChange={(e) => setWhenMode(e.target.value as any)} style={{ ...inputStyle, width: 220 }} data-testid="when-mode">
            <option value="none">none</option>
            <option value="form">form</option>
            <option value="advanced">advanced JSON</option>
          </select>
          <div style={{ opacity: 0.75, fontSize: 13 }}>复杂条件可切到 advanced。</div>
        </div>

        {whenMode === "advanced" && (
          <div style={{ marginTop: 10 }}>
            <label style={labelStyle}>when JSON</label>
            <textarea
              value={whenJson}
              onChange={(e) => setWhenJson(e.target.value)}
              style={{ ...inputStyle, minHeight: 120, ...monoStyle }}
              placeholder='例如: { "all": [ { "time": { "after":"22:30" } }, { "deviceId":"...", "traitPath":"...", "operator":"eq", "value":"on" } ] }'
              data-testid="when-json"
            />
          </div>
        )}

        {whenMode === "form" && (
          <>
            <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>time.after</label>
                <input value={whenTimeAfter} onChange={(e) => setWhenTimeAfter(e.target.value)} style={inputStyle} placeholder="22:30" data-testid="when-after" />
              </div>
              <div>
                <label style={labelStyle}>time.before</label>
                <input value={whenTimeBefore} onChange={(e) => setWhenTimeBefore(e.target.value)} style={inputStyle} placeholder="07:00" data-testid="when-before" />
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <h4 style={{ margin: 0, fontSize: 14 }}>device conditions (all)</h4>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  onClick={() => setWhenConds((prev) => [...prev, { deviceId: prefillDeviceId || devices[0]?.id || "", traitPath: "", operator: "eq", value: "" }])}
                  data-testid="when-add-cond"
                >
                  + condition
                </button>
              </div>
              {whenConds.length === 0 ? <div style={{ opacity: 0.75, fontSize: 13, marginTop: 6 }}>暂无 device condition</div> : null}
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                {whenConds.map((c, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: "0.75rem",
                      borderRadius: 14,
                      border: "1px solid rgba(255,255,255,0.08)",
                      background: "rgba(16, 24, 40, 0.35)",
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 10
                    }}
                    data-testid={`when-cond-${idx}`}
                  >
                    <div>
                      <label style={labelStyle}>deviceId</label>
                      <select
                        value={c.deviceId}
                        onChange={(e) =>
                          setWhenConds((prev) => prev.map((it, i) => (i === idx ? { ...it, deviceId: e.target.value } : it)))
                        }
                        style={inputStyle}
                      >
                        <option value="">选择设备...</option>
                        {devices.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name} ({d.id})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>traitPath</label>
                      <input
                        value={c.traitPath}
                        onChange={(e) =>
                          setWhenConds((prev) => prev.map((it, i) => (i === idx ? { ...it, traitPath: e.target.value } : it)))
                        }
                        style={inputStyle}
                        placeholder="例如: traits.raw.state"
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>operator</label>
                      <select
                        value={c.operator}
                        onChange={(e) =>
                          setWhenConds((prev) => prev.map((it, i) => (i === idx ? { ...it, operator: e.target.value as any } : it)))
                        }
                        style={inputStyle}
                      >
                        <option value="eq">eq</option>
                        <option value="neq">neq</option>
                        <option value="gt">gt</option>
                        <option value="gte">gte</option>
                        <option value="lt">lt</option>
                        <option value="lte">lte</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>value</label>
                      <input
                        value={toDisplayValue(c.value)}
                        onChange={(e) =>
                          setWhenConds((prev) =>
                            prev.map((it, i) => (i === idx ? { ...it, value: coerceJsonValue(e.target.value) } : it))
                          )
                        }
                        style={inputStyle}
                        placeholder='例如: on / 0 / "off"'
                      />
                    </div>
                    <div style={{ gridColumn: "1 / span 2", display: "flex", justifyContent: "flex-end" }}>
                      <button type="button" style={dangerButtonStyle} onClick={() => setWhenConds((prev) => prev.filter((_it, i) => i !== idx))}>
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: pageBg,
        color: "#e8edf7",
        fontFamily: "'Manrope', 'Segoe UI', system-ui, -apple-system, sans-serif",
        padding: "2.5rem"
      }}
      data-testid="automations-page"
    >
      <header style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-end" }}>
        <div>
          <div style={{ letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.8, fontSize: 12 }}>Automations</div>
          <h1 style={{ margin: "0.2rem 0 0.4rem 0", fontSize: "2rem" }}>联动（Automation）编辑</h1>
          <div style={{ opacity: 0.75, maxWidth: 860, fontSize: 13 }}>
            编辑并保存到 <span style={monoStyle}>automations.json</span>（由 API Gateway 写入，rules-engine 热加载执行）。
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button onClick={refreshLists} style={secondaryButtonStyle} disabled={loading}>
            {loading ? "加载中..." : "刷新"}
          </button>
          <button onClick={startNew} style={primaryButtonStyle} data-testid="automation-new">
            新建联动
          </button>
        </div>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "1.2rem", marginTop: "1.4rem" }}>
        <aside style={{ ...panelStyle, height: "calc(100vh - 220px)", overflow: "auto" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>联动列表</h2>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            {automationList.length === 0 && <div style={{ opacity: 0.75, fontSize: 13 }}>暂无联动</div>}
            {automationList.map((a) => {
              const active = a.id === selectedId;
              return (
                <button
                  key={a.id}
                  onClick={() => setSelectedId(a.id)}
                  style={{
                    textAlign: "left",
                    padding: "0.65rem 0.75rem",
                    borderRadius: 12,
                    cursor: "pointer",
                    border: active ? "1px solid rgba(34,197,94,0.6)" : "1px solid rgba(255,255,255,0.1)",
                    background: active ? "rgba(34,197,94,0.12)" : "rgba(0,0,0,0.18)",
                    color: "#e8edf7"
                  }}
                  data-testid={`automation-item-${a.id}`}
                >
                  <div style={{ fontWeight: 900 }}>{a.name || a.id}</div>
                  <div style={{ opacity: 0.8, fontSize: 12, ...monoStyle }}>{a.id}</div>
                  <div style={{ opacity: 0.7, fontSize: 12, marginTop: 2 }}>
                    {a.enabled === false ? "disabled" : "enabled"} · trigger: {a.trigger?.type}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <div style={{ ...panelStyle, height: "calc(100vh - 220px)", overflow: "auto" }}>
          {!draft ? (
            <div style={{ opacity: 0.75 }}>选择联动或点击“新建联动”。</div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={labelStyle}>ID</label>
                  <input
                    value={draft.id}
                    onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                    style={{ ...inputStyle, ...monoStyle }}
                    disabled={Boolean(selectedId)}
                    placeholder="例如: motion_to_sleep"
                    data-testid="automation-id"
                  />
                </div>
                <div>
                  <label style={labelStyle}>名称</label>
                  <input value={draft.name || ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} placeholder="可选" data-testid="automation-name" />
                </div>
              </div>

              <div style={{ marginTop: 10, display: "flex", gap: 16, alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.9, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={draft.enabled !== false}
                    onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                    data-testid="automation-enabled"
                  />
                  enabled
                </label>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <div style={{ width: 180 }}>
                    <label style={labelStyle}>forMs</label>
                    <input
                      type="number"
                      value={draft.forMs ?? 0}
                      onChange={(e) => setDraft({ ...draft, forMs: Number(e.target.value) })}
                      style={inputStyle}
                      data-testid="automation-forMs"
                    />
                  </div>
                  <div style={{ width: 180 }}>
                    <label style={labelStyle}>cooldownMs</label>
                    <input
                      type="number"
                      value={draft.cooldownMs ?? 0}
                      onChange={(e) => setDraft({ ...draft, cooldownMs: Number(e.target.value) })}
                      style={inputStyle}
                      data-testid="automation-cooldownMs"
                    />
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                {renderTrigger()}
                {renderWhen()}
              </div>

              <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center" }}>
                <button onClick={save} style={primaryButtonStyle} disabled={loading} data-testid="automation-save">
                  保存
                </button>
                {selectedId ? (
                  <button onClick={deleteAutomation} style={dangerButtonStyle} disabled={loading} data-testid="automation-delete">
                    删除
                  </button>
                ) : null}
                <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
                  <button onClick={addDeviceAction} style={secondaryButtonStyle} data-testid="automation-add-device-action">
                    + device action
                  </button>
                  <button onClick={addSceneAction} style={secondaryButtonStyle} data-testid="automation-add-scene-action">
                    + scene action
                  </button>
                </div>
              </div>

              {(status || details.length > 0) && (
                <div style={{ marginTop: 10, fontSize: 13, opacity: 0.9 }}>
                  {status ? <div>{status}</div> : null}
                  {details.length ? (
                    <ul style={{ margin: "8px 0 0 18px", padding: 0 }}>
                      {details.map((d, idx) => (
                        <li key={idx} style={{ opacity: 0.85 }}>
                          {d}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )}

              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                {draft.then.length === 0 ? <div style={{ opacity: 0.75, fontSize: 13 }}>暂无 then 动作。点击右上角添加。</div> : null}
                {draft.then.map((a, idx) => actionEditor(a, idx))}
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function AutomationDeviceActionEditor({
  index,
  action,
  devices,
  deviceMap,
  onChange
}: {
  index: number;
  action: Extract<AutomationAction, { type: "device" }>;
  devices: Device[];
  deviceMap: Record<string, Device>;
  onChange: (next: Partial<Extract<AutomationAction, { type: "device" }>>) => void;
}) {
  const device = deviceMap[action.deviceId];
  const caps = device?.capabilities || [];
  const cap = caps.find((c) => c.action === action.action);
  const params = action.params || {};

  const setParam = (name: string, value: any) => {
    const next = { ...params };
    if (value === "" || value === undefined || (typeof value === "number" && Number.isNaN(value))) {
      delete next[name];
    } else {
      next[name] = value;
    }
    onChange({ params: next });
  };

  const ensureWaitFor = () => {
    if (action.wait_for) return;
    onChange({
      wait_for: {
        traitPath: "",
        operator: "eq",
        value: "",
        timeoutMs: 20000,
        pollMs: 500,
        on_timeout: "abort"
      }
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={labelStyle}>deviceId</label>
          <select
            value={action.deviceId}
            onChange={(e) => {
              const deviceId = e.target.value;
              const nextCaps = deviceMap[deviceId]?.capabilities || [];
              onChange({ deviceId, action: nextCaps[0]?.action || "", params: {}, wait_for: undefined });
            }}
            style={inputStyle}
            data-testid={`then-deviceId-${index}`}
          >
            <option value="">选择设备...</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.id})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>action</label>
          <select
            value={action.action}
            onChange={(e) => onChange({ action: e.target.value, params: {}, wait_for: undefined })}
            style={inputStyle}
            data-testid={`then-action-${index}`}
          >
            <option value="">选择动作...</option>
            {caps.map((c) => (
              <option key={c.action} value={c.action}>
                {c.action}
              </option>
            ))}
          </select>
        </div>
      </div>

      {cap?.description ? <div style={{ opacity: 0.75, fontSize: 12 }}>动作说明：{cap.description}</div> : null}

      {Array.isArray(cap?.parameters) && cap.parameters.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {cap.parameters.map((p) => (
            <ParamInput
              key={p.name}
              param={p}
              value={params[p.name]}
              onChange={(val) => setParam(p.name, val)}
              testIdPrefix={`then-${index}`}
            />
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => {
            if (action.wait_for) onChange({ wait_for: undefined });
            else ensureWaitFor();
          }}
          style={secondaryButtonStyle}
          data-testid={`then-waitfor-toggle-${index}`}
        >
          {action.wait_for ? "移除 wait_for" : "+ wait_for"}
        </button>
      </div>

      {action.wait_for && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle}>traitPath</label>
            <input
              value={action.wait_for.traitPath || ""}
              onChange={(e) => onChange({ wait_for: { ...action.wait_for!, traitPath: e.target.value } })}
              style={inputStyle}
              placeholder="例如: traits.switch.state"
              data-testid={`then-waitfor-traitPath-${index}`}
            />
          </div>
          <div>
            <label style={labelStyle}>operator</label>
            <select
              value={action.wait_for.operator}
              onChange={(e) => onChange({ wait_for: { ...action.wait_for!, operator: e.target.value as any } })}
              style={inputStyle}
              data-testid={`then-waitfor-operator-${index}`}
            >
              <option value="eq">eq</option>
              <option value="neq">neq</option>
              <option value="gt">gt</option>
              <option value="gte">gte</option>
              <option value="lt">lt</option>
              <option value="lte">lte</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>value</label>
            <input
              value={toDisplayValue(action.wait_for.value)}
              onChange={(e) => onChange({ wait_for: { ...action.wait_for!, value: coerceJsonValue(e.target.value) } })}
              style={inputStyle}
              placeholder='例如: on / 0 / "off"'
              data-testid={`then-waitfor-value-${index}`}
            />
          </div>
          <div>
            <label style={labelStyle}>timeoutMs</label>
            <input
              type="number"
              value={action.wait_for.timeoutMs}
              onChange={(e) => onChange({ wait_for: { ...action.wait_for!, timeoutMs: Number(e.target.value) } })}
              style={inputStyle}
              data-testid={`then-waitfor-timeoutMs-${index}`}
            />
          </div>
          <div>
            <label style={labelStyle}>pollMs</label>
            <input
              type="number"
              value={action.wait_for.pollMs ?? 500}
              onChange={(e) => onChange({ wait_for: { ...action.wait_for!, pollMs: Number(e.target.value) } })}
              style={inputStyle}
              data-testid={`then-waitfor-pollMs-${index}`}
            />
          </div>
          <div>
            <label style={labelStyle}>on_timeout</label>
            <select
              value={action.wait_for.on_timeout || "abort"}
              onChange={(e) => onChange({ wait_for: { ...action.wait_for!, on_timeout: e.target.value as any } })}
              style={inputStyle}
              data-testid={`then-waitfor-on_timeout-${index}`}
            >
              <option value="abort">abort</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

function ParamInput({
  param,
  value,
  onChange,
  testIdPrefix
}: {
  param: CapabilityParam;
  value: any;
  onChange: (val: any) => void;
  testIdPrefix: string;
}) {
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
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.18)",
            background: "rgba(0,0,0,0.25)",
            color: "#e8edf7"
          }}
          data-testid={`${testIdPrefix}-param-${param.name}`}
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
        {param.minimum !== undefined || param.maximum !== undefined ? `(范围 ${param.minimum ?? "-"} ~ ${param.maximum ?? "-"})` : ""}
      </span>
      <input
        value={value ?? ""}
        onChange={(e) => onChange(param.type === "number" ? e.target.valueAsNumber : e.target.value)}
        type={param.type === "number" ? "number" : "text"}
        min={param.minimum}
        max={param.maximum}
        style={{
          padding: "0.45rem 0.5rem",
          borderRadius: 10,
          border: "1px solid rgba(255,255,255,0.18)",
          background: "rgba(0,0,0,0.25)",
          color: "#e8edf7"
        }}
        data-testid={`${testIdPrefix}-param-${param.name}`}
      />
    </label>
  );
}
