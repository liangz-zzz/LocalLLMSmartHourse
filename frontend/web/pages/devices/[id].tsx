import { useEffect, useState } from "react";
import { useRouter } from "next/router";

type Device = {
  id: string;
  name: string;
  traits?: any;
  capabilities?: { action: string; parameters?: any[] }[];
};

type ActionResult = {
  id: string;
  action: string;
  status: string;
  transport: string;
  createdAt?: string;
};

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
      const dRes = await fetch(`/api/devices/${id}`);
      const d = await dRes.json();
      setDevice(d);
      const hRes = await fetch(`/api/devices/${id}/history?limit=10`);
      const h = await hRes.json();
      setHistory(h.items || []);
    };
    load();
  }, [id]);

  const sendAction = async () => {
    if (!id || Array.isArray(id) || !action) return;
    setLoading(true);
    setMessage("");
    try {
      const body = { action };
      if (params) {
        try {
          Object.assign(body, { params: JSON.parse(params) });
        } catch {
          setMessage("参数必须是 JSON 对象");
          setLoading(false);
          return;
        }
      }
      const resp = await fetch(`/api/devices/${id}/actions`, {
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
    <main style={{ padding: "2rem", fontFamily: "Arial, sans-serif" }}>
      {!device && <p>Loading...</p>}
      {device && (
        <>
          <h1>{device.name}</h1>
          <p>ID: {device.id}</p>
          <section>
            <h3>动作</h3>
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">选择动作</option>
              {device.capabilities?.map((c) => (
                <option key={c.action} value={c.action}>
                  {c.action}
                </option>
              ))}
            </select>
            <textarea
              placeholder='参数 JSON (可选，如 {"brightness":80})'
              value={params}
              onChange={(e) => setParams(e.target.value)}
              style={{ display: "block", width: "300px", height: "80px", marginTop: "8px" }}
            />
            <button onClick={sendAction} disabled={loading || !action}>
              {loading ? "发送中..." : "发送动作"}
            </button>
            {message && <p>{message}</p>}
          </section>
          <section style={{ marginTop: "1.5rem" }}>
            <h3>动作历史 (最近)</h3>
            <ul>
              {history.map((h) => (
                <li key={h.id}>
                  {h.action} - {h.status} ({h.transport}) {h.createdAt ? new Date(h.createdAt).toLocaleString() : ""}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
