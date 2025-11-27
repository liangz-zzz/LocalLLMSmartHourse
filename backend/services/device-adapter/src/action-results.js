export function buildActionResult({ deviceId, action, status, transport, reason, params }) {
  return {
    id: `${deviceId}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    deviceId,
    action,
    status,
    transport,
    reason,
    params,
    ts: Date.now()
  };
}
