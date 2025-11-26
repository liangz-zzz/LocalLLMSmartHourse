import Redis from "ioredis";

export class RedisBus {
  constructor({ redisUrl, updatesChannel, actionsChannel, actionResultsChannel, logger }) {
    this.pub = new Redis(redisUrl);
    this.sub = new Redis(redisUrl);
    this.updatesChannel = updatesChannel;
    this.actionsChannel = actionsChannel;
    this.actionResultsChannel = actionResultsChannel;
    this.logger = logger;
    this.updateHandlers = new Set();
    this.actionResultHandlers = new Set();
    this.stateSnapshotHandlers = new Set();
  }

  async start() {
    const channels = [this.updatesChannel, this.actionResultsChannel, this.actionResultsChannel ? `${this.actionResultsChannel}:state` : null].filter(Boolean);
    if (channels.length) {
      await this.sub.subscribe(channels);
      this.sub.on("message", (channel, message) => {
        try {
          const parsed = JSON.parse(message);
          if (channel === this.updatesChannel) {
            for (const handler of this.updateHandlers) handler(parsed);
          } else if (channel === this.actionResultsChannel) {
            for (const handler of this.actionResultHandlers) handler(parsed);
          } else if (channel === `${this.actionResultsChannel}:state`) {
            for (const handler of this.stateSnapshotHandlers) handler(parsed);
          }
        } catch (err) {
          this.logger?.warn("Failed to parse pubsub message", err);
        }
      });
      this.logger?.info("Subscribed to channels", channels);
    }
  }

  onUpdate(handler) {
    this.updateHandlers.add(handler);
    return () => this.updateHandlers.delete(handler);
  }

  onActionResult(handler) {
    this.actionResultHandlers.add(handler);
    return () => this.actionResultHandlers.delete(handler);
  }

  onStateSnapshot(handler) {
    this.stateSnapshotHandlers.add(handler);
    return () => this.stateSnapshotHandlers.delete(handler);
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
