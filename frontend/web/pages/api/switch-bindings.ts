import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const base = process.env.API_HTTP_BASE || "http://localhost:4000";
  const apiKey = process.env.API_GATEWAY_API_KEY || "";
  const url = new URL(`${base}/switch-bindings`);
  const panelId = Array.isArray(req.query.panelId) ? req.query.panelId[0] : req.query.panelId;
  if (panelId) url.searchParams.set("panelId", panelId);
  if (!["GET", "POST"].includes(req.method || "")) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  try {
    const resp = await fetch(url, {
      method: req.method,
      headers: {
        ...(req.method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...(apiKey ? { "X-API-Key": apiKey } : {})
      },
      ...(req.method === "POST" ? { body: JSON.stringify(req.body || {}) } : {})
    });
    return res.status(resp.status).json(await resp.json());
  } catch (err) {
    return res.status(500).json({ error: "failed", message: (err as Error).message });
  }
}
