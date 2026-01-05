import type { NextApiRequest, NextApiResponse } from "next";
import { Readable } from "node:stream";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const base = process.env.API_HTTP_BASE || "http://localhost:4000";
  const { path } = req.query;
  if (!path || (Array.isArray(path) && path.length === 0)) {
    return res.status(400).json({ error: "bad_request" });
  }
  const suffix = Array.isArray(path) ? path.map(encodeURIComponent).join("/") : encodeURIComponent(path || "");

  try {
    const resp = await fetch(`${base}/assets/${suffix}`);
    res.status(resp.status);
    const contentType = resp.headers.get("content-type");
    if (contentType) res.setHeader("content-type", contentType);
    const cache = resp.headers.get("cache-control");
    if (cache) res.setHeader("cache-control", cache);
    const body = resp.body;
    if (!body) {
      res.end();
      return;
    }
    Readable.fromWeb(body).pipe(res);
  } catch (err) {
    res.status(500).json({ error: "failed", message: (err as Error).message });
  }
}
