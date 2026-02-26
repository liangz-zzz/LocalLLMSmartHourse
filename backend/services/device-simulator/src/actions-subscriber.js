import Redis from "ioredis";

export class ActionsSubscriber {
  constructor({ redisUrl, channel, onAction, logger }) {
    this.redisUrl = redisUrl;
    this.channel = channel;
    this.logger = logger;
    this.sub = null;
    this.onAction = onAction;
    this.queue = Promise.resolve();
  }

  async start() {
    this.sub = new Redis(this.redisUrl);
    await this.sub.subscribe(this.channel);
    this.sub.on("message", (_channel, message) => {
      this.queue = this.queue
        .then(async () => {
          let parsed;
          try {
            parsed = JSON.parse(message);
          } catch (err) {
            this.logger?.error?.("Failed to parse action", err?.message || String(err));
            return;
          }

          await this.onAction?.(parsed);
        })
        .catch((err) => {
          this.logger?.error?.("Failed to handle action", err?.message || String(err));
        });
    });
    this.logger?.info?.("Subscribed to actions channel", this.channel);
  }

  async stop() {
    await this.queue.catch(() => {});
    if (this.sub) {
      const s = this.sub;
      this.sub = null;
      await s.unsubscribe(this.channel);
      await s.quit();
    }
  }
}
