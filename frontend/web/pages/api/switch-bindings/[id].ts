import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const base = process.env.API_HTTP_BASE || "http://localhost:4000";
  const apiKey = process.env.API_GATEWAY_API_KEY || "";
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) return res.status(400).json({ error: "bad_request" });
  if (!["GET", "PUT", "DELETE"].includes(req.method || "")) {
    res.setHeader("Allow", "GET, PUT, DELETE");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  try {
    const resp = await fetch(`${base}/switch-bindings/${encodeURIComponent(id)}`, {
      method: req.method,
      headers: {
        ...(req.method === "PUT" ? { "Content-Type": "application/json" } : {}),
        ...(apiKey ? { "X-API-Key": apiKey } : {})
      },
      ...(req.method === "PUT" ? { body: JSON.stringify(req.body || {}) } : {})
    });
    return res.status(resp.status).json(await resp.json());
  } catch (err) {
    return res.status(500).json({ error: "failed", message: (err as Error).message });
  }
}
