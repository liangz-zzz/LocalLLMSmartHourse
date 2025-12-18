export function loadConfig() {
  return {
    port: Number(process.env.PORT || 7000),
    apiGatewayBase: (process.env.API_GATEWAY_BASE || "http://api-gateway:4000").replace(/\/$/, ""),
    apiGatewayApiKey: process.env.API_GATEWAY_API_KEY || "",
    // Safe default: do not execute writes unless explicitly requested.
    defaultDryRun: process.env.DRY_RUN_DEFAULT !== "false"
  };
}
