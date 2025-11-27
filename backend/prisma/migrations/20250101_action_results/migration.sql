CREATE TABLE IF NOT EXISTS "ActionResult" (
  "id" TEXT PRIMARY KEY,
  "deviceId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "transport" TEXT NOT NULL,
  "reason" TEXT,
  "params" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "action_results_device_idx" ON "ActionResult" ("deviceId");
