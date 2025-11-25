import Redis from "ioredis";

export class ActionsSubscriber {
  constructor({ redisUrl, channel, logger }) {
    this.redisUrl = redisUrl;
    this.channel = channel;
    this.logger = logger;
    this.sub = null;
  }

  async start(onAction) {
    this.sub = new Redis(this.redisUrl);
    await this.sub.subscribe(this.channel);
    this.sub.on("message", (_channel, message) => {
      try {
        const parsed = JSON.parse(message);
        onAction?.(parsed);
      } catch (err) {
        this.logger?.error?.("Failed to parse action", err);
      }
    });
    this.logger?.info?.("Subscribed to actions channel", this.channel);
  }

  async stop() {
    if (this.sub) {
      const s = this.sub;
      this.sub = null;
      await s.unsubscribe(this.channel);
      await s.quit();
    }
  }
}
