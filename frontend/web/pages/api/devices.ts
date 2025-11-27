import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const base = process.env.API_HTTP_BASE || "http://localhost:4000";
    const resp = await fetch(`${base}/devices`);
    const data = await resp.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: "failed", message: (err as Error).message });
  }
}
