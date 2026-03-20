import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const base = process.env.API_HTTP_BASE || "http://localhost:4000";
    const apiKey = process.env.API_GATEWAY_API_KEY || "";
    const url = new URL(`${base}/devices`);
    const floorplanId = Array.isArray(req.query?.floorplanId) ? req.query.floorplanId[0] : req.query?.floorplanId;
    if (floorplanId) {
      url.searchParams.set("floorplanId", String(floorplanId));
    }
    const resp = await fetch(url, {
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
