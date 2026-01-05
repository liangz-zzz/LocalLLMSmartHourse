import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const base = process.env.API_HTTP_BASE || "http://localhost:4000";
  try {
    const resp = await fetch(`${base}/scenes`);
    const data = await resp.json();
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: "failed", message: (err as Error).message });
  }
}
