export function loadConfig() {
  return {
    port: Number(process.env.PORT || 4000),
    mode: process.env.MODE || "mock", // mock | redis
    redisUrl: process.env.REDIS_URL || "redis://redis:6379",
    logLevel: process.env.LOG_LEVEL || "info"
  };
}
