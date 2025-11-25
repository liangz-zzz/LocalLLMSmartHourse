import Redis from "ioredis";

export class RedisBus {
  constructor({ redisUrl, updatesChannel, actionsChannel, logger }) {
    this.pub = new Redis(redisUrl);
    this.sub = new Redis(redisUrl);
    this.updatesChannel = updatesChannel;
    this.actionsChannel = actionsChannel;
    this.logger = logger;
    this.updateHandlers = new Set();
  }

  async start() {
    if (this.updatesChannel) {
      await this.sub.subscribe(this.updatesChannel);
      this.sub.on("message", (channel, message) => {
        if (channel !== this.updatesChannel) return;
        try {
          const parsed = JSON.parse(message);
          for (const handler of this.updateHandlers) {
            handler(parsed);
          }
        } catch (err) {
          this.logger?.warn("Failed to parse update message", err);
        }
      });
      this.logger?.info("Subscribed to updates channel", this.updatesChannel);
    }
  }

  onUpdate(handler) {
    this.updateHandlers.add(handler);
    return () => this.updateHandlers.delete(handler);
  }

  async publishAction(action) {
    if (!this.actionsChannel) return;
    await this.pub.publish(this.actionsChannel, JSON.stringify(action));
  }

  async stop() {
    const p = [];
    p.push(this.pub.quit());
    if (this.sub) {
      p.push(this.sub.unsubscribe(this.updatesChannel));
      p.push(this.sub.quit());
    }
    await Promise.all(p);
  }
}
