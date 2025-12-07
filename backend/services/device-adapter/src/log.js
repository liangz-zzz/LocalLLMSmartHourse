const LEVELS = ["error", "warn", "info", "debug"];

export class Logger {
  constructor(level = "info") {
    this.level = LEVELS.includes(level) ? level : "info";
  }

  shouldLog(level) {
    return LEVELS.indexOf(level) <= LEVELS.indexOf(this.level);
  }

  info(...args) {
    if (this.shouldLog("info")) this.log("info", args);
  }
  warn(...args) {
    if (this.shouldLog("warn")) this.log("warn", args);
  }
  error(...args) {
    if (this.shouldLog("error")) this.log("error", args);
  }
  debug(...args) {
    if (this.shouldLog("debug")) this.log("debug", args);
  }

  log(level, args) {
    const ts = Date.now();
    if (args.length === 1 && typeof args[0] === "object") {
      console.log(JSON.stringify({ level, ts, ...args[0] }));
    } else {
      console.log(JSON.stringify({ level, ts, msg: args }));
    }
  }
}
