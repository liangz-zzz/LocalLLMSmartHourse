import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (!id || Array.isArray(id)) return res.status(400).json({ error: "bad_request" });
  try {
    const base = process.env.API_HTTP_BASE || "http://localhost:4000";
    const resp = await fetch(`${base}/devices/${id}`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "failed", message: (err as Error).message });
  }
}
