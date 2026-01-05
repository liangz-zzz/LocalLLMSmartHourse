import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const base = process.env.API_HTTP_BASE || "http://localhost:4000";
  const { id } = req.query;
  if (!id || Array.isArray(id)) return res.status(400).json({ error: "bad_request" });

  try {
    const resp = await fetch(`${base}/scenes/${encodeURIComponent(id)}/expanded`);
    const data = await resp.json();
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: "failed", message: (err as Error).message });
  }
}
