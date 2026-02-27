import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const base = process.env.API_HTTP_BASE || "http://localhost:4000";
  const apiKey = process.env.API_GATEWAY_API_KEY || "";
  const { id } = req.query;
  if (!id || Array.isArray(id)) return res.status(400).json({ error: "bad_request" });

  if (req.method === "PUT") {
    try {
      const resp = await fetch(`${base}/virtual-devices/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "X-API-Key": apiKey } : {})
        },
        body: JSON.stringify(req.body || {})
      });
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } catch (err) {
      return res.status(500).json({ error: "failed", message: (err as Error).message });
    }
  }

  if (req.method === "DELETE") {
    try {
      const resp = await fetch(`${base}/virtual-devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: {
          ...(apiKey ? { "X-API-Key": apiKey } : {})
        }
      });
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } catch (err) {
      return res.status(500).json({ error: "failed", message: (err as Error).message });
    }
  }

  res.setHeader("Allow", "PUT, DELETE");
  return res.status(405).json({ error: "method_not_allowed" });
}

