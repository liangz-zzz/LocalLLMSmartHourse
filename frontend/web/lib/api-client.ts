export type CapabilityParam = {
  name: string;
  type: "boolean" | "number" | "string" | "enum";
  minimum?: number;
  maximum?: number;
  enum?: string[];
  required?: boolean;
};

export type Capability = {
  action: string;
  description?: string;
  parameters?: CapabilityParam[];
};

export type Device = {
  id: string;
  name: string;
  placement?: { room?: string; zone?: string; description?: string };
  traits?: Record<string, any>;
  capabilities?: Capability[];
};

export type ActionResult = {
  id: string;
  deviceId: string;
  action: string;
  status: string;
  transport?: string;
  reason?: string;
  params?: Record<string, any>;
  createdAt?: string;
};

const apiBase = process.env.NEXT_PUBLIC_API_HTTP_BASE || process.env.API_HTTP_BASE || "http://localhost:4000";

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase.replace(/\/$/, "")}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error || res.statusText);
    // @ts-expect-error attach reason
    error.reason = body.reason;
    throw error;
  }
  return res.json();
}

export const ApiClient = {
  listDevices: () => jsonFetch<{ items: Device[]; count: number }>("/devices"),
  getDevice: (id: string) => jsonFetch<Device>(`/devices/${id}`),
  sendAction: (id: string, action: string, params?: Record<string, any>) =>
    jsonFetch<{ status: string }>(`/devices/${id}/actions`, {
      method: "POST",
      body: JSON.stringify({ action, params })
    }),
  listActionResults: (id: string, opts?: { limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    if (opts?.limit) search.set("limit", String(opts.limit));
    if (opts?.offset) search.set("offset", String(opts.offset));
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return jsonFetch<{ items: ActionResult[]; limit: number; offset: number }>(`/devices/${id}/actions${suffix}`);
  },
  listRules: () => jsonFetch<{ items: any[] }>("/rules"),
  createRule: (rule: any) =>
    jsonFetch(`/rules`, {
      method: "POST",
      body: JSON.stringify(rule)
    }),
  updateRule: (id: string, rule: any) =>
    jsonFetch(`/rules/${id}`, {
      method: "PUT",
      body: JSON.stringify(rule)
    }),
  deleteRule: (id: string) =>
    jsonFetch<{ status: string }>(`/rules/${id}`, {
      method: "DELETE"
    })
};
