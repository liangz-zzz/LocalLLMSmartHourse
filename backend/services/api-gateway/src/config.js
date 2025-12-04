export function loadConfig() {
  const defaultMode = process.env.MODE ? process.env.MODE : "redis"; // prefer redis when services are up
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
    apiKeys: (process.env.API_KEYS || process.env.API_KEY || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  };
}
