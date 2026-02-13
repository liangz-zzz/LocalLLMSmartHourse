import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const base = process.env.API_HTTP_BASE || "http://localhost:4000";
    const apiKey = process.env.API_GATEWAY_API_KEY || "";
    const resp = await fetch(`${base}/devices`, {
      headers: {
        ...(apiKey ? { "X-API-Key": apiKey } : {})
      }
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "failed", message: (err as Error).message });
  }
}
