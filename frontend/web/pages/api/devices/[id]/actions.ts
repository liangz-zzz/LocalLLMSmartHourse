import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const base = process.env.API_HTTP_BASE || "http://localhost:4000";
  const apiKey = process.env.API_GATEWAY_API_KEY || "";
  const { id } = req.query;
  if (!id || Array.isArray(id)) return res.status(400).json({ error: "bad_request" });

  try {
    const resp = await fetch(`${base}/devices/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "X-API-Key": apiKey } : {})
      },
      body: JSON.stringify(req.body || {})
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "failed", message: (err as Error).message });
  }
}
