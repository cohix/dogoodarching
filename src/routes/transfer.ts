// Export / import of the caller's own account. Athletes only (0003 §5):
// coaches have no personal data, and team meals are never exported/imported.

import { Hono } from "hono";
import { getDb } from "../db";
import { buildContentDisposition, validateJson } from "../lib/http";
import { authMiddleware, requireAthlete, type AppBindings } from "../lib/rbac";
import { importPayloadSchema } from "../lib/validation";
import { exportFilename, exportUserData, importUserData, MAX_IMPORT_BYTES } from "../services/transfer";

const transfer = new Hono<AppBindings>();

transfer.use("*", authMiddleware);

transfer.get("/export", requireAthlete, async (c) => {
  const payload = await exportUserData(getDb(c.env.DB), c.get("user").id, c.get("user").username);
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": buildContentDisposition(exportFilename(), "application/json"),
    },
  });
});

transfer.post("/import", requireAthlete, validateJson(importPayloadSchema, MAX_IMPORT_BYTES), async (c) => {
  return c.json(await importUserData(getDb(c.env.DB), c.env.ATTACHMENTS, c.get("user").id, c.req.valid("json").data));
});

export default transfer;
