export function buildActionResult({ deviceId, action, status, transport, reason, params, errorCode, details }) {
  const out = {
    id: `${deviceId}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    deviceId,
    action,
    status,
    transport,
    reason,
    params,
    ts: Date.now()
  };
  if (errorCode) out.errorCode = errorCode;
  if (details && typeof details === "object") out.details = details;
  return out;
}
