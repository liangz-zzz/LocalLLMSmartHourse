import type { NextApiRequest, NextApiResponse } from "next";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export const config = {
  api: {
    bodyParser: false
  }
};
const UPSTREAM_TIMEOUT_MS = 240_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const base = process.env.API_HTTP_BASE || "http://localhost:4000";
  const apiKey = process.env.API_GATEWAY_API_KEY || "";
  try {
    const target = new URL(`${base.replace(/\/$/, "")}/assets`);
    const contentType = req.headers["content-type"];
    const headers: Record<string, string> = {
      ...(contentType ? { "content-type": Array.isArray(contentType) ? contentType[0] : contentType } : {}),
      ...(apiKey ? { "x-api-key": apiKey } : {})
    };

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
      const upstreamReq = requestFn(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers
        },
        (upstreamRes) => {
          const chunks: Buffer[] = [];
          upstreamRes.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          upstreamRes.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const status = upstreamRes.statusCode || 502;
            const upstreamContentType = String(upstreamRes.headers["content-type"] || "");
            if (upstreamContentType.includes("application/json")) {
              let payload: any = {};
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                payload = { error: "upstream_invalid_json", body };
              }
              res.status(status).json(payload);
            } else {
              res.status(status).json({ error: "upstream_error", body: body || "" });
            }
            finish();
          });
        }
      );

      upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
        upstreamReq.destroy(new Error(`asset_proxy_timeout_${UPSTREAM_TIMEOUT_MS}ms`));
      });

      upstreamReq.on("error", (err) => {
        if (!res.headersSent) {
          const isTimeout = String(err?.message || "").includes("asset_proxy_timeout");
          res.status(isTimeout ? 504 : 502).json({ error: "failed", message: err.message });
        }
        finish();
      });

      req.on("data", (chunk) => {
        upstreamReq.write(chunk);
      });
      req.on("end", () => {
        upstreamReq.end();
      });
      req.on("aborted", () => {
        upstreamReq.destroy(new Error("client_aborted"));
      });
      req.on("error", (err) => {
        upstreamReq.destroy(err);
      });
    });
    return;
  } catch (err) {
    return res.status(500).json({ error: "failed", message: (err as Error).message });
  }
}
