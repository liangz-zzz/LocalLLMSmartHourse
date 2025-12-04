import { WebSocketServer } from "ws";

export function setupWs({ server, bus, mode = "redis", logger, apiKeys = [] }) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set();

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const filterIds = url.searchParams.get("devices");
    const deviceSet = filterIds ? new Set(filterIds.split(",").map((s) => s.trim()).filter(Boolean)) : null;
    if (apiKeys.length) {
      const qsKey = url.searchParams.get("api_key");
      const headerKey = req.headers["x-api-key"] || (req.headers["sec-websocket-protocol"] || "").replace(/Bearer\s+/i, "");
      const ok = apiKeys.includes(String(qsKey)) || apiKeys.includes(String(headerKey));
      if (!ok) {
        socket.close(4401, "unauthorized");
        return;
      }
    }

    clients.add({ socket, devices: deviceSet });
    socket.send(JSON.stringify({ type: "hello", mode }));
    socket.on("close", () => {
      for (const entry of clients) {
        if (entry.socket === socket) {
          clients.delete(entry);
          break;
        }
      }
    });
  });

  const unsubscribe = bus?.onUpdate?.((update) => {
    const msg = JSON.stringify({ type: "device_update", data: update });
    for (const client of clients) {
      if (client.socket.readyState === client.socket.OPEN) {
        if (client.devices && update?.id && !client.devices.has(update.id)) continue;
        client.socket.send(msg);
      }
    }
  }) || (() => {});

  const unsubscribeAction = bus?.onActionResult?.((result) => {
    const msg = JSON.stringify({ type: "action_result", data: result });
    for (const client of clients) {
      if (client.socket.readyState === client.socket.OPEN) {
        if (client.devices && result?.id && !client.devices.has(result.id)) continue;
        client.socket.send(msg);
      }
    }
  }) || (() => {});

  const unsubscribeState = bus?.onStateSnapshot?.((snapshot) => {
    const msg = JSON.stringify({ type: "state_snapshot", data: snapshot });
    for (const client of clients) {
      if (client.socket.readyState === client.socket.OPEN) {
        if (client.devices && snapshot?.id && !client.devices.has(snapshot.id)) continue;
        client.socket.send(msg);
      }
    }
  }) || (() => {});

  const stop = () => {
    unsubscribe();
    unsubscribeAction();
    unsubscribeState();
    clients.forEach(({ socket }) => socket.close());
    return new Promise((resolve) => wss.close(() => resolve()));
  };

  logger?.info?.("WebSocket server ready on /ws");
  return { stop };
}
