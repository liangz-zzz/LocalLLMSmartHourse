const LEVELS = ["error", "warn", "info", "debug"];

export class Logger {
  constructor(level = "info") {
    this.level = LEVELS.includes(level) ? level : "info";
  }

  shouldLog(level) {
    return LEVELS.indexOf(level) <= LEVELS.indexOf(this.level);
  }

  info(...args) {
    if (this.shouldLog("info")) console.log("[info]", ...args);
  }
  warn(...args) {
    if (this.shouldLog("warn")) console.warn("[warn]", ...args);
  }
  error(...args) {
    if (this.shouldLog("error")) console.error("[error]", ...args);
  }
  debug(...args) {
    if (this.shouldLog("debug")) console.log("[debug]", ...args);
  }
}
