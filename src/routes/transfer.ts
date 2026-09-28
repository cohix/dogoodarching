// Export / import of the caller's own account (both roles).

import { Hono } from "hono";
import { getDb } from "../db";
import { buildContentDisposition, validateJson } from "../lib/http";
import { authMiddleware, type AppBindings } from "../lib/rbac";
import { importPayloadSchema } from "../lib/validation";
import { exportFilename, exportUserData, importUserData } from "../services/transfer";

const transfer = new Hono<AppBindings>();

transfer.use("*", authMiddleware);

transfer.get("/export", async (c) => {
  const payload = await exportUserData(getDb(c.env.DB), c.get("user").id, c.get("user").username);
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": buildContentDisposition(exportFilename(), "application/json"),
    },
  });
});

transfer.post("/import", validateJson(importPayloadSchema), async (c) => {
  return c.json(await importUserData(getDb(c.env.DB), c.env.ATTACHMENTS, c.get("user").id, c.req.valid("json").data));
});

export default transfer;
