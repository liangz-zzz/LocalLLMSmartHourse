import type { NextApiRequest, NextApiResponse } from "next";

export const config = {
  api: {
    bodyParser: false
  }
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const base = process.env.API_HTTP_BASE || "http://localhost:4000";
  try {
    const resp = await fetch(`${base}/assets`, {
      method: "POST",
      headers: {
        "content-type": req.headers["content-type"] || ""
      },
      body: req,
      duplex: "half"
    });
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: "failed", message: (err as Error).message });
  }
}
