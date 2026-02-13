import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const base = process.env.API_HTTP_BASE || "http://localhost:4000";
  const apiKey = process.env.API_GATEWAY_API_KEY || "";

  if (req.method === "GET") {
    try {
      const resp = await fetch(`${base}/scenes`, {
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

  if (req.method === "POST") {
    try {
      const resp = await fetch(`${base}/scenes`, {
        method: "POST",
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

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "method_not_allowed" });
}
