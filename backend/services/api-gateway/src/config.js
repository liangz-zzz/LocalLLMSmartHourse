import path from "node:path";

export function loadConfig() {
  const defaultMode = process.env.MODE ? process.env.MODE : "redis"; // prefer redis when services are up
  const configDir = String(process.env.CONFIG_DIR || "").trim();
  const scenesPath = String(process.env.SCENES_PATH || "").trim() || (configDir ? path.join(configDir, "scenes.json") : "./scenes.json");
  const floorplansPath =
    String(process.env.FLOORPLANS_PATH || "").trim() || (configDir ? path.join(configDir, "floorplans.json") : "./floorplans.json");
  const assetsDir = String(process.env.ASSETS_DIR || "").trim() || (configDir ? path.join(configDir, "assets") : "./assets");
  const assetMaxImageMb = parsePositiveNumber(process.env.ASSET_MAX_IMAGE_MB, 20);
  const assetMaxModelMb = parsePositiveNumber(process.env.ASSET_MAX_MODEL_MB, 200);
  return {
    port: Number(process.env.PORT || 4000),
    mode: defaultMode, // mock | redis
    redisUrl: process.env.REDIS_URL || "redis://redis:6379",
    redisUpdatesChannel: process.env.REDIS_UPDATES_CHANNEL || "device:updates",
    redisActionsChannel: process.env.REDIS_ACTIONS_CHANNEL || "device:actions",
    redisActionResultsChannel: process.env.REDIS_ACTION_RESULTS_CHANNEL || "device:action_results",
    redisStateChannel: process.env.REDIS_STATE_CHANNEL || "device:action_results:state",
    databaseUrl: process.env.DATABASE_URL || "postgres://smarthome:smarthome@db:5432/smarthome",
    actionResultsPersist: process.env.ACTION_RESULTS_PERSIST !== "false",
    logLevel: process.env.LOG_LEVEL || "info",
    configDir: configDir || undefined,
    scenesPath,
    floorplansPath,
    assetsDir,
    assetMaxImageMb,
    assetMaxModelMb,
    apiKeys: (process.env.API_KEYS || process.env.API_KEY || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    jwtSecret: process.env.JWT_SECRET || "",
    jwtAudience: process.env.JWT_AUD || process.env.JWT_AUDIENCE,
    jwtIssuer: process.env.JWT_ISS || process.env.JWT_ISSUER
  };
}

function parsePositiveNumber(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return num;
}
