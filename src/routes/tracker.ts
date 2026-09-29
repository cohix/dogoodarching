// Personal tracker endpoints: every handler operates on the caller's own data.

import { Hono } from "hono";
import { getDb } from "../db";
import { actingUserId, rateLimit } from "../lib/rate-limit";
import { dateKeyUtc } from "../lib/dates";
import { jsonError, parsePositiveInt, validateJson, validateQuery } from "../lib/http";
import { authMiddleware, type AppBindings } from "../lib/rbac";
import {
  adjustInput, checkInput, cycleWeekPlanInput, duplicateSetupInput, inspirationInput, maintenanceItemCheckInput,
  maintenanceItemInput, maintenanceItemLabelInput, maintenanceSectionInput, plannedSessionInput,
  plannedSessionLinkInput, poundageInput, practiceScoreInput, sessionInput, setupInput, trackerQuery, weeklyNoteInput,
} from "../lib/validation";
import { uploadPlannedSessionFileFor, addPlannedSessionLinkFor, deletePlannedSessionAttachmentFor, fileDownloadHeaders, openAttachmentFileFor } from "../services/attachments";
import { getTrackerPayload } from "../services/dashboard";
import { addInspirationFor } from "../services/inspiration";
import {
  addMaintenanceItemFor, clearMaintenanceSectionFor, deleteMaintenanceItemFor, setCheckFor, setMaintenanceItemCheckedFor, updateMaintenanceItemFor,
} from "../services/maintenance";
import { adjustScheduleFor, saveCycleWeekPlanFor, savePlannedSessionFor, savePoundageFor } from "../services/plan";
import { addPracticeScoreFor, deletePracticeScoreFor } from "../services/scores";
import { addSessionFor, deleteSessionFor, saveWeeklyNoteFor, updateSessionFor } from "../services/sessions";
import { duplicateSetupFor, saveSetupFor } from "../services/setups";

const tracker = new Hono<AppBindings>();

tracker.use("*", authMiddleware);

tracker.get("/tracker", validateQuery(trackerQuery), async (c) => {
  const today = c.req.valid("query").today ?? dateKeyUtc(new Date());
  return c.json(await getTrackerPayload(getDb(c.env.DB), c.get("user").id, today, c.req.valid("query").before));
});

tracker.post("/notes/weekly", validateJson(weeklyNoteInput), async (c) => {
  return c.json(await saveWeeklyNoteFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json")));
});

tracker.post("/sessions", validateJson(sessionInput), async (c) => {
  return c.json(await addSessionFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json")));
});

tracker.put("/sessions/:id", validateJson(sessionInput), async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return jsonError(c, 400, "Invalid session id");
  const result = await updateSessionFor(getDb(c.env.DB), c.get("user").id, id, c.req.valid("json"));
  if (!result) return jsonError(c, 404, "Session not found");
  return c.json(result);
});

tracker.delete("/sessions/:id", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return jsonError(c, 400, "Invalid session id");
  const result = await deleteSessionFor(getDb(c.env.DB), c.get("user").id, id);
  if (!result) return jsonError(c, 404, "Session not found");
  return c.json(result);
});

tracker.post("/scores", validateJson(practiceScoreInput), async (c) => {
  return c.json(await addPracticeScoreFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json")));
});

tracker.delete("/scores/:id", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return jsonError(c, 400, "Invalid score id");
  const result = await deletePracticeScoreFor(getDb(c.env.DB), c.get("user").id, id);
  if (!result) return jsonError(c, 404, "Score not found");
  return c.json(result);
});

tracker.post("/plan/sessions", validateJson(plannedSessionInput), async (c) => {
  return c.json(await savePlannedSessionFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json")));
});

tracker.post("/plan/sessions/links", validateJson(plannedSessionLinkInput), async (c) => {
  return c.json(await addPlannedSessionLinkFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json")));
});

tracker.post("/plan/sessions/files", rateLimit("upload", actingUserId), async (c) => {
  return c.json(await uploadPlannedSessionFileFor(getDb(c.env.DB), c.env.ATTACHMENTS, c.get("user").id, c.get("user").id, c.req.raw));
});

tracker.delete("/plan/attachments/:id", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return jsonError(c, 400, "Invalid attachment id");
  const deleted = await deletePlannedSessionAttachmentFor(getDb(c.env.DB), c.env.ATTACHMENTS, c.get("user").id, id);
  if (!deleted) return jsonError(c, 404, "Attachment not found");
  return c.json({ ok: true });
});

tracker.get("/plan/attachments/:id/file", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return jsonError(c, 400, "Invalid attachment id");
  const file = await openAttachmentFileFor(getDb(c.env.DB), c.env.ATTACHMENTS, id, c.get("user"));
  if (!file) return jsonError(c, 404, "File not found");
  return new Response(file.object.body, { headers: fileDownloadHeaders(file.attachment, file.object) });
});

tracker.post("/plan/weeks", validateJson(cycleWeekPlanInput), async (c) => {
  return c.json(await saveCycleWeekPlanFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json")));
});

tracker.post("/plan/adjust", validateJson(adjustInput), async (c) => {
  return c.json(await adjustScheduleFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json")));
});

tracker.post("/plan/poundage", validateJson(poundageInput), async (c) => {
  return c.json(await savePoundageFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json").poundage, c.req.valid("json").today));
});

tracker.post("/checks", validateJson(checkInput), async (c) => {
  return c.json(await setCheckFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json")));
});

tracker.post("/maintenance/items", validateJson(maintenanceItemInput), async (c) => {
  return c.json(await addMaintenanceItemFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json")));
});

tracker.put("/maintenance/items/:id", validateJson(maintenanceItemLabelInput), async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return jsonError(c, 400, "Invalid item id");
  const result = await updateMaintenanceItemFor(getDb(c.env.DB), c.get("user").id, id, c.req.valid("json").label);
  if (!result) return jsonError(c, 404, "Maintenance item not found");
  return c.json(result);
});

tracker.delete("/maintenance/items/:id", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return jsonError(c, 400, "Invalid item id");
  const result = await deleteMaintenanceItemFor(getDb(c.env.DB), c.get("user").id, id);
  if (!result) return jsonError(c, 404, "Maintenance item not found");
  return c.json(result);
});

tracker.post("/maintenance/items/:id/check", validateJson(maintenanceItemCheckInput), async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return jsonError(c, 400, "Invalid item id");
  return c.json(await setMaintenanceItemCheckedFor(getDb(c.env.DB), c.get("user").id, id, c.req.valid("json").checked));
});

tracker.post("/maintenance/sections/clear", validateJson(maintenanceSectionInput), async (c) => {
  return c.json(await clearMaintenanceSectionFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json").section));
});

tracker.post("/setups", validateJson(setupInput), async (c) => {
  const result = await saveSetupFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json"));
  if (!result) return jsonError(c, 404, "Setup not found");
  return c.json(result);
});

tracker.post("/setups/:id/duplicate", validateJson(duplicateSetupInput), async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return jsonError(c, 400, "Invalid setup id");
  const result = await duplicateSetupFor(getDb(c.env.DB), c.get("user").id, id, c.req.valid("json").poundage);
  if (!result) return jsonError(c, 404, "Setup not found");
  return c.json(result);
});

tracker.post("/inspiration", validateJson(inspirationInput), async (c) => {
  return c.json(await addInspirationFor(getDb(c.env.DB), c.get("user").id, c.req.valid("json")));
});

export default tracker;
