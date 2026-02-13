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

type WaitFor = {
  traitPath: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  value: any;
  timeoutMs: number;
  pollMs?: number;
  on_timeout?: "abort";
};

type SceneStep =
  | { type: "scene"; sceneId: string }
  | { type: "device"; deviceId: string; action: string; params?: Record<string, any>; wait_for?: WaitFor };

type Scene = {
  id: string;
  name: string;
  description?: string;
  steps: SceneStep[];
};

const pageBg = "linear-gradient(135deg, #0f172a 0%, #1f2a44 45%, #0b5b5c 100%)";

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
  background: "#10b981",
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

export default function ScenesPage() {
  const router = useRouter();
  const prefillDeviceId = typeof router.query.deviceId === "string" ? router.query.deviceId : "";

  const [sceneList, setSceneList] = useState<SceneSummary[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [draft, setDraft] = useState<Scene | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [details, setDetails] = useState<string[]>([]);
  const [cascadeDelete, setCascadeDelete] = useState(false);

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
      const [scenesRes, devicesRes] = await Promise.all([fetch("/api/scenes"), fetch("/api/devices")]);
      const scenesJson = await scenesRes.json();
      const devicesJson = await devicesRes.json();
      setSceneList(scenesJson.items || []);
      setDevices(devicesJson.items || []);
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadScene = async (id: string) => {
    setStatus("");
    setDetails([]);
    setLoading(true);
    try {
      const resp = await fetch(`/api/scenes/${encodeURIComponent(id)}`);
      const data = await resp.json();
      if (!resp.ok) {
        setStatus(data?.error || "加载失败");
        return;
      }
      setDraft(data);
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshLists();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    loadScene(selectedId);
  }, [selectedId]);

  const startNew = () => {
    setSelectedId("");
    setDraft({ id: "", name: "", description: "", steps: [] });
    setStatus("");
    setDetails([]);
  };

  const save = async () => {
    if (!draft) return;
    setLoading(true);
    setStatus("保存中...");
    setDetails([]);
    try {
      const isNew = !selectedId;
      const url = isNew ? "/api/scenes" : `/api/scenes/${encodeURIComponent(selectedId)}`;
      const method = isNew ? "POST" : "PUT";
      const resp = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft)
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
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const deleteScene = async () => {
    if (!selectedId) return;
    const ok = window.confirm(`确认删除场景 ${selectedId}？`);
    if (!ok) return;
    setLoading(true);
    setStatus("删除中...");
    setDetails([]);
    try {
      const qs = cascadeDelete ? "?cascade=1" : "";
      const resp = await fetch(`/api/scenes/${encodeURIComponent(selectedId)}${qs}`, { method: "DELETE" });
      const data = await resp.json();
      if (!resp.ok) {
        setStatus(data?.reason || data?.error || "删除失败");
        setDetails(data?.dependents ? data.dependents.map((d: string) => `dependents: ${d}`) : data?.details || []);
        return;
      }
      setStatus("已删除");
      setDraft(null);
      setSelectedId("");
      await refreshLists();
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const moveStep = (index: number, delta: number) => {
    if (!draft) return;
    const next = [...draft.steps];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const tmp = next[index];
    next[index] = next[target];
    next[target] = tmp;
    setDraft({ ...draft, steps: next });
  };

  const removeStep = (index: number) => {
    if (!draft) return;
    const next = draft.steps.filter((_s, i) => i !== index);
    setDraft({ ...draft, steps: next });
  };

  const addDeviceStep = () => {
    if (!draft) return;
    const fallbackDeviceId = prefillDeviceId || devices[0]?.id || "";
    const caps = deviceMap[fallbackDeviceId]?.capabilities || [];
    const fallbackAction = caps[0]?.action || "";
    setDraft({
      ...draft,
      steps: [
        ...draft.steps,
        {
          type: "device",
          deviceId: fallbackDeviceId,
          action: fallbackAction,
          params: {}
        }
      ]
    });
  };

  const addSceneStep = () => {
    if (!draft) return;
    const options = sceneList.map((s) => s.id).filter(Boolean);
    const first = options[0] || "";
    setDraft({
      ...draft,
      steps: [
        ...draft.steps,
        {
          type: "scene",
          sceneId: first
        }
      ]
    });
  };

  const stepEditor = (step: SceneStep, index: number) => {
    if (!draft) return null;
    const updateStep = (patch: Partial<SceneStep>) => {
      const next = [...draft.steps];
      next[index] = { ...(next[index] as any), ...(patch as any) };
      setDraft({ ...draft, steps: next });
    };

    const setStepType = (type: "device" | "scene") => {
      if (type === step.type) return;
      const next = [...draft.steps];
      if (type === "device") {
        const fallbackDeviceId = prefillDeviceId || devices[0]?.id || "";
        const caps = deviceMap[fallbackDeviceId]?.capabilities || [];
        next[index] = { type: "device", deviceId: fallbackDeviceId, action: caps[0]?.action || "", params: {} };
      } else {
        next[index] = { type: "scene", sceneId: sceneList[0]?.id || "" };
      }
      setDraft({ ...draft, steps: next });
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
        data-testid={`scene-step-${index}`}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ fontWeight: 900, opacity: 0.85 }}>Step {index + 1}</span>
            <select
              value={step.type}
              onChange={(e) => setStepType(e.target.value as any)}
              style={{ ...inputStyle, width: 160 }}
              data-testid={`step-type-${index}`}
            >
              <option value="device">device</option>
              <option value="scene">scene</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={secondaryButtonStyle} onClick={() => moveStep(index, -1)} disabled={index === 0}>
              上移
            </button>
            <button style={secondaryButtonStyle} onClick={() => moveStep(index, +1)} disabled={index === draft.steps.length - 1}>
              下移
            </button>
            <button style={dangerButtonStyle} onClick={() => removeStep(index)}>
              删除
            </button>
          </div>
        </div>

        {step.type === "scene" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
            <label style={labelStyle}>sceneId</label>
            <select
              value={step.sceneId}
              onChange={(e) => updateStep({ sceneId: e.target.value } as any)}
              style={inputStyle}
              data-testid={`scene-step-sceneId-${index}`}
            >
              <option value="">选择场景...</option>
              {sceneList
                .filter((s) => s.id !== draft.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.id})
                  </option>
                ))}
            </select>
          </div>
        )}

        {step.type === "device" && (
          <DeviceStepEditor
            index={index}
            step={step}
            devices={devices}
            deviceMap={deviceMap}
            onChange={(next) => updateStep(next as any)}
          />
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
      data-testid="scenes-page"
    >
      <header style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-end" }}>
        <div>
          <div style={{ letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.8, fontSize: 12 }}>Scenes</div>
          <h1 style={{ margin: "0.2rem 0 0.4rem 0", fontSize: "2rem" }}>场景编辑</h1>
          <div style={{ opacity: 0.75, maxWidth: 780, fontSize: 13 }}>
            可视化编辑并保存到 <span style={monoStyle}>scenes.json</span>（由 API Gateway 管理）。支持 device step / scene 引用 / wait_for。
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button onClick={refreshLists} style={secondaryButtonStyle} disabled={loading}>
            {loading ? "加载中..." : "刷新"}
          </button>
          <button onClick={startNew} style={primaryButtonStyle} data-testid="scene-new">
            新建场景
          </button>
        </div>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "1.2rem", marginTop: "1.4rem" }}>
        <aside style={{ ...panelStyle, height: "calc(100vh - 220px)", overflow: "auto" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>场景列表</h2>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            {sceneList.length === 0 && <div style={{ opacity: 0.75, fontSize: 13 }}>暂无场景</div>}
            {sceneList.map((s) => {
              const active = s.id === selectedId;
              return (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  style={{
                    textAlign: "left",
                    padding: "0.65rem 0.75rem",
                    borderRadius: 12,
                    cursor: "pointer",
                    border: active ? "1px solid rgba(16,185,129,0.6)" : "1px solid rgba(255,255,255,0.1)",
                    background: active ? "rgba(16,185,129,0.12)" : "rgba(0,0,0,0.18)",
                    color: "#e8edf7"
                  }}
                  data-testid={`scene-item-${s.id}`}
                >
                  <div style={{ fontWeight: 900 }}>{s.name}</div>
                  <div style={{ opacity: 0.8, fontSize: 12, ...monoStyle }}>{s.id}</div>
                  {s.description ? <div style={{ opacity: 0.7, fontSize: 12, marginTop: 2 }}>{s.description}</div> : null}
                </button>
              );
            })}
          </div>
        </aside>

        <div style={{ ...panelStyle, height: "calc(100vh - 220px)", overflow: "auto" }}>
          {!draft ? (
            <div style={{ opacity: 0.75 }}>选择场景或点击“新建场景”。</div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={labelStyle}>ID</label>
                  <input
                    value={draft.id}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setDraft({ ...draft, id: nextId });
                    }}
                    style={{ ...inputStyle, ...monoStyle }}
                    disabled={Boolean(selectedId)}
                    placeholder="例如: sleep"
                    data-testid="scene-id"
                  />
                </div>
                <div>
                  <label style={labelStyle}>名称</label>
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    style={inputStyle}
                    placeholder="例如: 睡觉"
                    data-testid="scene-name"
                  />
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <label style={labelStyle}>描述</label>
                <input
                  value={draft.description || ""}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  style={inputStyle}
                  placeholder="可选"
                  data-testid="scene-description"
                />
              </div>

              <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}>
                <button onClick={save} style={primaryButtonStyle} disabled={loading} data-testid="scene-save">
                  保存
                </button>
                {selectedId && (
                  <>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.85, fontSize: 13 }}>
                      <input type="checkbox" checked={cascadeDelete} onChange={(e) => setCascadeDelete(e.target.checked)} />
                      级联删除
                    </label>
                    <button onClick={deleteScene} style={dangerButtonStyle} disabled={loading} data-testid="scene-delete">
                      删除
                    </button>
                  </>
                )}
                <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
                  <button onClick={addDeviceStep} style={secondaryButtonStyle} data-testid="scene-add-device-step">
                    + device step
                  </button>
                  <button onClick={addSceneStep} style={secondaryButtonStyle} data-testid="scene-add-scene-step">
                    + scene step
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

              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                {draft.steps.length === 0 ? (
                  <div style={{ opacity: 0.75, fontSize: 13 }}>暂无步骤。点击右上角添加。</div>
                ) : (
                  draft.steps.map((s, idx) => stepEditor(s, idx))
                )}
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function DeviceStepEditor({
  index,
  step,
  devices,
  deviceMap,
  onChange
}: {
  index: number;
  step: Extract<SceneStep, { type: "device" }>;
  devices: Device[];
  deviceMap: Record<string, Device>;
  onChange: (next: Partial<Extract<SceneStep, { type: "device" }>>) => void;
}) {
  const device = deviceMap[step.deviceId];
  const caps = device?.capabilities || [];
  const cap = caps.find((c) => c.action === step.action);
  const params = step.params || {};

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
    if (step.wait_for) return;
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
            value={step.deviceId}
            onChange={(e) => {
              const deviceId = e.target.value;
              const nextCaps = deviceMap[deviceId]?.capabilities || [];
              onChange({ deviceId, action: nextCaps[0]?.action || "", params: {}, wait_for: undefined });
            }}
            style={inputStyle}
            data-testid={`scene-step-deviceId-${index}`}
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
            value={step.action}
            onChange={(e) => onChange({ action: e.target.value, params: {}, wait_for: undefined })}
            style={inputStyle}
            data-testid={`scene-step-action-${index}`}
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

      {Array.isArray(cap?.parameters) && cap?.parameters.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {cap.parameters.map((p) => (
            <ParamInput
              key={p.name}
              param={p}
              value={params[p.name]}
              onChange={(val) => setParam(p.name, val)}
              testIdPrefix={`scene-step-${index}`}
            />
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => {
            if (step.wait_for) onChange({ wait_for: undefined });
            else ensureWaitFor();
          }}
          style={secondaryButtonStyle}
          data-testid={`scene-step-waitfor-toggle-${index}`}
        >
          {step.wait_for ? "移除 wait_for" : "+ wait_for"}
        </button>
      </div>

      {step.wait_for && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle}>traitPath</label>
            <input
              value={step.wait_for.traitPath || ""}
              onChange={(e) => onChange({ wait_for: { ...step.wait_for!, traitPath: e.target.value } })}
              style={inputStyle}
              placeholder="例如: traits.switch.state"
              data-testid={`scene-step-waitfor-traitPath-${index}`}
            />
          </div>
          <div>
            <label style={labelStyle}>operator</label>
            <select
              value={step.wait_for.operator}
              onChange={(e) => onChange({ wait_for: { ...step.wait_for!, operator: e.target.value as any } })}
              style={inputStyle}
              data-testid={`scene-step-waitfor-operator-${index}`}
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
              value={toDisplayValue(step.wait_for.value)}
              onChange={(e) => onChange({ wait_for: { ...step.wait_for!, value: coerceJsonValue(e.target.value) } })}
              style={inputStyle}
              placeholder='例如: on / 0 / "off"'
              data-testid={`scene-step-waitfor-value-${index}`}
            />
          </div>
          <div>
            <label style={labelStyle}>timeoutMs</label>
            <input
              type="number"
              value={step.wait_for.timeoutMs}
              onChange={(e) => onChange({ wait_for: { ...step.wait_for!, timeoutMs: Number(e.target.value) } })}
              style={inputStyle}
              data-testid={`scene-step-waitfor-timeoutMs-${index}`}
            />
          </div>
          <div>
            <label style={labelStyle}>pollMs</label>
            <input
              type="number"
              value={step.wait_for.pollMs ?? 500}
              onChange={(e) => onChange({ wait_for: { ...step.wait_for!, pollMs: Number(e.target.value) } })}
              style={inputStyle}
              data-testid={`scene-step-waitfor-pollMs-${index}`}
            />
          </div>
          <div>
            <label style={labelStyle}>on_timeout</label>
            <select
              value={step.wait_for.on_timeout || "abort"}
              onChange={(e) => onChange({ wait_for: { ...step.wait_for!, on_timeout: e.target.value as any } })}
              style={inputStyle}
              data-testid={`scene-step-waitfor-on_timeout-${index}`}
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
