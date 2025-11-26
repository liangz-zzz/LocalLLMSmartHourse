import { WebSocketServer } from "ws";

export function setupWs({ server, bus, mode = "redis", logger }) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set();

  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: "hello", mode }));
    socket.on("close", () => clients.delete(socket));
  });

  const unsubscribe = bus?.onUpdate?.((update) => {
    const msg = JSON.stringify({ type: "device_update", data: update });
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(msg);
      }
    }
  }) || (() => {});

  const unsubscribeAction = bus?.onActionResult?.((result) => {
    const msg = JSON.stringify({ type: "action_result", data: result });
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(msg);
      }
    }
  }) || (() => {});

  const unsubscribeState = bus?.onStateSnapshot?.((snapshot) => {
    const msg = JSON.stringify({ type: "state_snapshot", data: snapshot });
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(msg);
      }
    }
  }) || (() => {});

  const stop = () => {
    unsubscribe();
    unsubscribeAction();
    unsubscribeState();
    clients.forEach((c) => c.close());
    return new Promise((resolve) => wss.close(() => resolve()));
  };

  logger?.info?.("WebSocket server ready on /ws");
  return { stop };
}
