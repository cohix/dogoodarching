// Export / import for the caller's own account (both roles).
//
// Export downloads dga-export-YYYYMMDD.json. LIMITATION: file attachments
// (kind "document" | "photo") are EXCLUDED from the export — their blob bytes
// live in R2 and are not serialized; only link attachments are included.
// Import replaces ALL of the caller's data in a single D1 batch, remapping
// ids, and never touches other users' rows.

import { Hono } from "hono";
import { and, asc, eq, max, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";
import { getDb, schema, type Db } from "../db";
import { authMiddleware, type AppBindings } from "../lib/rbac";
import { readJsonBody, zodErrorMessage, sessionType, planDayKey, attachmentKind, maintenanceSection } from "./tracker";

const transfer = new Hono<AppBindings>();

transfer.use("*", authMiddleware);

const isoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "Invalid date" });

const importPayloadSchema = z.object({
  version: z.literal(1),
  data: z.object({
    trainingSessions: z.array(z.object({
      id: z.number().int(), sessionDate: z.string(), sessionType, customActivity: z.string(),
      arrows: z.number().int(), durationMinutes: z.number().int(), focus: z.string(), score: z.string(),
      notes: z.string(), createdAt: isoDateTime,
    })),
    practiceScores: z.array(z.object({
      id: z.number().int(), scoreDate: z.string(), total: z.number().int(), createdAt: isoDateTime,
    })),
    practiceScoreEnds: z.array(z.object({
      id: z.number().int(), scoreId: z.number().int(), endNumber: z.number().int(), arrow1: z.number().int(),
      arrow2: z.number().int(), arrow3: z.number().int(), endTotal: z.number().int(),
    })),
    programState: z.object({
      currentPoundage: z.number().int(), currentCycle: z.number().int(), currentWeek: z.number().int(),
      updatedAt: isoDateTime,
    }).nullable(),
    cycleWeekPlans: z.array(z.object({
      weekNumber: z.number().int(), primaryFocus: z.string(), backgroundFocusOne: z.string(),
      backgroundFocusTwo: z.string(), updatedAt: isoDateTime,
    })),
    plannedSessionOverrides: z.array(z.object({
      dayKey: planDayKey, sessionType: z.string(), detail: z.string(), prescription: z.string(),
      updatedAt: isoDateTime,
    })),
    plannedSessionAttachments: z.array(z.object({
      id: z.number().int(), dayKey: planDayKey, kind: attachmentKind,
      label: z.string(), url: z.string(), mimeType: z.string(), createdAt: isoDateTime,
    })),
    milestoneChecks: z.array(z.object({ key: z.string(), checked: z.boolean(), updatedAt: isoDateTime })),
    maintenanceChecks: z.array(z.object({ key: z.string(), checked: z.boolean(), updatedAt: isoDateTime })),
    maintenanceItems: z.array(z.object({
      id: z.number().int(), section: maintenanceSection, label: z.string(),
      sortOrder: z.number().int(), createdAt: isoDateTime, updatedAt: isoDateTime,
    })),
    inspirationEntries: z.array(z.object({
      id: z.number().int(), thoughtText: z.string(), videoTitle: z.string(), videoUrl: z.string(),
      recipeName: z.string(), recipeSummary: z.string(), recipeIngredients: z.string(),
      recipeInstructions: z.string(), updatedAt: isoDateTime,
    })),
    weeklyNotes: z.array(z.object({
      id: z.number().int(), weekStart: z.string(), notes: z.string(),
      createdAt: isoDateTime, updatedAt: isoDateTime,
    })),
    bowSetups: z.array(z.object({
      id: z.number().int(), poundage: z.number().int(), name: z.string(), limbRiser: z.string(),
      tillerBolts: z.string(), braceHeight: z.string(), stringTwists: z.string(), nockingPoint: z.string(),
      centerShot: z.string(), plunger: z.string(), gripNotes: z.string(), stabilizer: z.string(),
      clickerPosition: z.string(), bareShaft: z.string(), walkBack: z.string(), arrowsInUse: z.string(),
      sightMarksJson: z.string(), updatedAt: isoDateTime,
    })),
    entries: z.array(z.object({ id: z.number().int(), text: z.string(), createdAt: isoDateTime })),
  }),
});

transfer.get("/export", async (c) => {
  const db = getDb(c.env.DB);
  const userId = c.get("user").id;
  const [
    sessionRows, scoreRows, endRows, stateRows, weekPlanRows, overrideRows, attachmentRows,
    milestoneRows, maintenanceRows, itemRows, inspirationRows, noteRows, setupRows, entryRows,
  ] = await Promise.all([
    db.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.userId, userId)).orderBy(asc(schema.trainingSessions.id)),
    db.select().from(schema.practiceScores).where(eq(schema.practiceScores.userId, userId)).orderBy(asc(schema.practiceScores.id)),
    db.select().from(schema.practiceScoreEnds).where(eq(schema.practiceScoreEnds.userId, userId)).orderBy(asc(schema.practiceScoreEnds.id)),
    db.select().from(schema.programState).where(eq(schema.programState.userId, userId)).limit(1),
    db.select().from(schema.cycleWeekPlans).where(eq(schema.cycleWeekPlans.userId, userId)).orderBy(asc(schema.cycleWeekPlans.weekNumber)),
    db.select().from(schema.plannedSessionOverrides).where(eq(schema.plannedSessionOverrides.userId, userId)),
    db.select().from(schema.plannedSessionAttachments).where(eq(schema.plannedSessionAttachments.userId, userId)).orderBy(asc(schema.plannedSessionAttachments.id)),
    db.select().from(schema.milestoneChecks).where(eq(schema.milestoneChecks.userId, userId)),
    db.select().from(schema.maintenanceChecks).where(eq(schema.maintenanceChecks.userId, userId)),
    db.select().from(schema.maintenanceItems).where(eq(schema.maintenanceItems.userId, userId)).orderBy(asc(schema.maintenanceItems.id)),
    db.select().from(schema.inspirationEntries).where(eq(schema.inspirationEntries.userId, userId)).orderBy(asc(schema.inspirationEntries.id)),
    db.select().from(schema.weeklyNotes).where(eq(schema.weeklyNotes.userId, userId)).orderBy(asc(schema.weeklyNotes.id)),
    db.select().from(schema.bowSetups).where(eq(schema.bowSetups.userId, userId)).orderBy(asc(schema.bowSetups.id)),
    db.select().from(schema.entries).where(eq(schema.entries.userId, userId)).orderBy(asc(schema.entries.id)),
  ]);
  const iso = (d: Date) => d.toISOString();
  const state = stateRows[0];
  const payload = {
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    username: c.get("user").username,
    data: {
      trainingSessions: sessionRows.map((r) => ({
        id: r.id, sessionDate: r.sessionDate, sessionType: r.sessionType, customActivity: r.customActivity,
        arrows: r.arrows, durationMinutes: r.durationMinutes, focus: r.focus, score: r.score,
        notes: r.notes, createdAt: iso(r.createdAt),
      })),
      practiceScores: scoreRows.map((r) => ({ id: r.id, scoreDate: r.scoreDate, total: r.total, createdAt: iso(r.createdAt) })),
      practiceScoreEnds: endRows.map((r) => ({
        id: r.id, scoreId: r.scoreId, endNumber: r.endNumber, arrow1: r.arrow1, arrow2: r.arrow2,
        arrow3: r.arrow3, endTotal: r.endTotal,
      })),
      programState: state
        ? { currentPoundage: state.currentPoundage, currentCycle: state.currentCycle, currentWeek: state.currentWeek, updatedAt: iso(state.updatedAt) }
        : null,
      cycleWeekPlans: weekPlanRows.map((r) => ({
        weekNumber: r.weekNumber, primaryFocus: r.primaryFocus, backgroundFocusOne: r.backgroundFocusOne,
        backgroundFocusTwo: r.backgroundFocusTwo, updatedAt: iso(r.updatedAt),
      })),
      plannedSessionOverrides: overrideRows.map((r) => ({
        dayKey: r.dayKey, sessionType: r.sessionType, detail: r.detail, prescription: r.prescription,
        updatedAt: iso(r.updatedAt),
      })),
      // File attachments are excluded: their bytes live in R2 and cannot be
      // serialized into the JSON export. Only link attachments are exported.
      plannedSessionAttachments: attachmentRows
        .filter((r) => r.kind === "link")
        .map((r) => ({ id: r.id, dayKey: r.dayKey, kind: r.kind, label: r.label, url: r.url, mimeType: r.mimeType, createdAt: iso(r.createdAt) })),
      milestoneChecks: milestoneRows.map((r) => ({ key: r.key, checked: r.checked, updatedAt: iso(r.updatedAt) })),
      maintenanceChecks: maintenanceRows.map((r) => ({ key: r.key, checked: r.checked, updatedAt: iso(r.updatedAt) })),
      maintenanceItems: itemRows.map((r) => ({
        id: r.id, section: r.section, label: r.label, sortOrder: r.sortOrder,
        createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
      })),
      inspirationEntries: inspirationRows.map((r) => ({
        id: r.id, thoughtText: r.thoughtText, videoTitle: r.videoTitle, videoUrl: r.videoUrl,
        recipeName: r.recipeName, recipeSummary: r.recipeSummary, recipeIngredients: r.recipeIngredients,
        recipeInstructions: r.recipeInstructions, updatedAt: iso(r.updatedAt),
      })),
      weeklyNotes: noteRows.map((r) => ({
        id: r.id, weekStart: r.weekStart, notes: r.notes, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
      })),
      bowSetups: setupRows.map((r) => ({
        id: r.id, poundage: r.poundage, name: r.name, limbRiser: r.limbRiser, tillerBolts: r.tillerBolts,
        braceHeight: r.braceHeight, stringTwists: r.stringTwists, nockingPoint: r.nockingPoint,
        centerShot: r.centerShot, plunger: r.plunger, gripNotes: r.gripNotes, stabilizer: r.stabilizer,
        clickerPosition: r.clickerPosition, bareShaft: r.bareShaft, walkBack: r.walkBack,
        arrowsInUse: r.arrowsInUse, sightMarksJson: r.sightMarksJson,
        updatedAt: iso(r.updatedAt),
      })),
      entries: entryRows.map((r) => ({ id: r.id, text: r.text, createdAt: iso(r.createdAt) })),
    },
  };
  const filename = `dga-export-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`;
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

transfer.post("/import", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = importPayloadSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  const db = getDb(c.env.DB);
  const userId = c.get("user").id;
  const data = parsed.data.data;

  // Global high-water marks so remapped ids cannot collide with other users' rows.
  const [mSessions, mScores, mEnds, mNotes, mItems, mSetups, mInspiration, mEntries, mAttachments] = await Promise.all([
    db.select({ m: max(schema.trainingSessions.id) }).from(schema.trainingSessions),
    db.select({ m: max(schema.practiceScores.id) }).from(schema.practiceScores),
    db.select({ m: max(schema.practiceScoreEnds.id) }).from(schema.practiceScoreEnds),
    db.select({ m: max(schema.weeklyNotes.id) }).from(schema.weeklyNotes),
    db.select({ m: max(schema.maintenanceItems.id) }).from(schema.maintenanceItems),
    db.select({ m: max(schema.bowSetups.id) }).from(schema.bowSetups),
    db.select({ m: max(schema.inspirationEntries.id) }).from(schema.inspirationEntries),
    db.select({ m: max(schema.entries.id) }).from(schema.entries),
    db.select({ m: max(schema.plannedSessionAttachments.id) }).from(schema.plannedSessionAttachments),
  ]);
  const counters: Record<string, number> = {
    trainingSessions: mSessions[0]?.m ?? 0,
    practiceScores: mScores[0]?.m ?? 0,
    practiceScoreEnds: mEnds[0]?.m ?? 0,
    weeklyNotes: mNotes[0]?.m ?? 0,
    maintenanceItems: mItems[0]?.m ?? 0,
    bowSetups: mSetups[0]?.m ?? 0,
    inspirationEntries: mInspiration[0]?.m ?? 0,
    entries: mEntries[0]?.m ?? 0,
    plannedSessionAttachments: mAttachments[0]?.m ?? 0,
  };
  const idMaps: Record<string, Map<number, number>> = {};
  const nextId = (table: string): number => {
    counters[table] = (counters[table] ?? 0) + 1;
    return counters[table] as number;
  };
  const recordId = (table: string, oldId: number, newId: number): void => {
    (idMaps[table] ??= new Map()).set(oldId, newId);
  };
  const remapped = (table: string, oldId: number): number | undefined => idMaps[table]?.get(oldId);

  const newTrainingSessions = data.trainingSessions.map((r) => {
    const id = nextId("trainingSessions");
    recordId("trainingSessions", r.id, id);
    return {
      id, userId, sessionDate: r.sessionDate, sessionType: r.sessionType, customActivity: r.customActivity,
      arrows: r.arrows, durationMinutes: r.durationMinutes, focus: r.focus, score: r.score,
      notes: r.notes, createdAt: new Date(r.createdAt),
    };
  });
  const newPracticeScores = data.practiceScores.map((r) => {
    const id = nextId("practiceScores");
    recordId("practiceScores", r.id, id);
    return { id, userId, scoreDate: r.scoreDate, total: r.total, createdAt: new Date(r.createdAt) };
  });
  const newPracticeScoreEnds = data.practiceScoreEnds
    .filter((r) => remapped("practiceScores", r.scoreId) !== undefined)
    .map((r) => {
      const id = nextId("practiceScoreEnds");
      recordId("practiceScoreEnds", r.id, id);
      return {
        id, userId, scoreId: remapped("practiceScores", r.scoreId) as number, endNumber: r.endNumber,
        arrow1: r.arrow1, arrow2: r.arrow2, arrow3: r.arrow3, endTotal: r.endTotal,
      };
    });
  const newProgramState = data.programState
    ? [{
        userId, currentPoundage: data.programState.currentPoundage, currentCycle: data.programState.currentCycle,
        currentWeek: data.programState.currentWeek, updatedAt: new Date(data.programState.updatedAt),
      }]
    : [];
  const newCycleWeekPlans = data.cycleWeekPlans.map((r) => ({
    userId, weekNumber: r.weekNumber, primaryFocus: r.primaryFocus,
    backgroundFocusOne: r.backgroundFocusOne, backgroundFocusTwo: r.backgroundFocusTwo,
    updatedAt: new Date(r.updatedAt),
  }));
  const newPlannedSessionOverrides = data.plannedSessionOverrides.map((r) => ({
    userId, dayKey: r.dayKey, sessionType: r.sessionType, detail: r.detail,
    prescription: r.prescription, updatedAt: new Date(r.updatedAt),
  }));
  const newPlannedSessionAttachments = data.plannedSessionAttachments.map((r) => {
    const id = nextId("plannedSessionAttachments");
    recordId("plannedSessionAttachments", r.id, id);
    return {
      id, userId, dayKey: r.dayKey, kind: r.kind, label: r.label, url: r.url,
      blobKey: "", mimeType: r.mimeType, createdAt: new Date(r.createdAt),
    };
  });
  const newMilestoneChecks = data.milestoneChecks.map((r) => ({
    userId, key: r.key, checked: r.checked, updatedAt: new Date(r.updatedAt),
  }));
  const newMaintenanceItems = data.maintenanceItems.map((r) => {
    const id = nextId("maintenanceItems");
    recordId("maintenanceItems", r.id, id);
    return {
      id, userId, section: r.section, label: r.label, sortOrder: r.sortOrder,
      createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt),
    };
  });
  const newMaintenanceChecks = data.maintenanceChecks.map((r) => {
    const match = /^item:(\d+)$/.exec(r.key);
    const key = match ? `item:${remapped("maintenanceItems", Number(match[1])) ?? match[1]}` : r.key;
    return { userId, key, checked: r.checked, updatedAt: new Date(r.updatedAt) };
  });
  const newInspirationEntries = data.inspirationEntries.map((r) => {
    const id = nextId("inspirationEntries");
    recordId("inspirationEntries", r.id, id);
    return {
      id, userId, thoughtText: r.thoughtText, videoTitle: r.videoTitle, videoUrl: r.videoUrl,
      recipeName: r.recipeName, recipeSummary: r.recipeSummary, recipeIngredients: r.recipeIngredients,
      recipeInstructions: r.recipeInstructions, updatedAt: new Date(r.updatedAt),
    };
  });
  const newWeeklyNotes = data.weeklyNotes.map((r) => {
    const id = nextId("weeklyNotes");
    recordId("weeklyNotes", r.id, id);
    return {
      id, userId, weekStart: r.weekStart, notes: r.notes,
      createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt),
    };
  });
  const newBowSetups = data.bowSetups.map((r) => {
    const id = nextId("bowSetups");
    recordId("bowSetups", r.id, id);
    return {
      id, userId, poundage: r.poundage, name: r.name, limbRiser: r.limbRiser, tillerBolts: r.tillerBolts,
      braceHeight: r.braceHeight, stringTwists: r.stringTwists, nockingPoint: r.nockingPoint,
      centerShot: r.centerShot, plunger: r.plunger, gripNotes: r.gripNotes, stabilizer: r.stabilizer,
      clickerPosition: r.clickerPosition, bareShaft: r.bareShaft, walkBack: r.walkBack,
      arrowsInUse: r.arrowsInUse, sightMarksJson: r.sightMarksJson,
      updatedAt: new Date(r.updatedAt),
    };
  });
  const newEntries = data.entries.map((r) => {
    const id = nextId("entries");
    recordId("entries", r.id, id);
    return { id, userId, text: r.text, createdAt: new Date(r.createdAt) };
  });

  // Import replaces the caller's plan attachments (only link attachments are
  // ever imported), so delete the R2 blobs of their existing file attachments
  // first — otherwise the rows would be dropped by the batch below while the
  // blobs linger in R2 unreachable and unbillable-but-uncollectible.
  const orphanBlobs = await db
    .select({ blobKey: schema.plannedSessionAttachments.blobKey })
    .from(schema.plannedSessionAttachments)
    .where(
      and(
        eq(schema.plannedSessionAttachments.userId, userId),
        ne(schema.plannedSessionAttachments.blobKey, ""),
      ),
    );
  await Promise.all(orphanBlobs.map((r) => c.env.ATTACHMENTS.delete(r.blobKey)));

  // One D1 batch: delete everything the caller owns (children first), then
  // re-insert the imported rows with remapped ids. Other users' rows are
  // never touched. Insert statements are chunked so no statement is oversized.
  const statements: BatchItem<"sqlite">[] = [
    db.delete(schema.practiceScoreEnds).where(eq(schema.practiceScoreEnds.userId, userId)),
    db.delete(schema.practiceScores).where(eq(schema.practiceScores.userId, userId)),
    db.delete(schema.plannedSessionAttachments).where(eq(schema.plannedSessionAttachments.userId, userId)),
    db.delete(schema.plannedSessionOverrides).where(eq(schema.plannedSessionOverrides.userId, userId)),
    db.delete(schema.cycleWeekPlans).where(eq(schema.cycleWeekPlans.userId, userId)),
    db.delete(schema.trainingSessions).where(eq(schema.trainingSessions.userId, userId)),
    db.delete(schema.milestoneChecks).where(eq(schema.milestoneChecks.userId, userId)),
    db.delete(schema.maintenanceChecks).where(eq(schema.maintenanceChecks.userId, userId)),
    db.delete(schema.maintenanceItems).where(eq(schema.maintenanceItems.userId, userId)),
    db.delete(schema.inspirationEntries).where(eq(schema.inspirationEntries.userId, userId)),
    db.delete(schema.weeklyNotes).where(eq(schema.weeklyNotes.userId, userId)),
    db.delete(schema.bowSetups).where(eq(schema.bowSetups.userId, userId)),
    db.delete(schema.entries).where(eq(schema.entries.userId, userId)),
    db.delete(schema.programState).where(eq(schema.programState.userId, userId)),
    ...chunk(newTrainingSessions, 100).map((rows) => db.insert(schema.trainingSessions).values(rows)),
    ...chunk(newPracticeScores, 100).map((rows) => db.insert(schema.practiceScores).values(rows)),
    ...chunk(newPracticeScoreEnds, 100).map((rows) => db.insert(schema.practiceScoreEnds).values(rows)),
    ...chunk(newCycleWeekPlans, 100).map((rows) => db.insert(schema.cycleWeekPlans).values(rows)),
    ...chunk(newPlannedSessionOverrides, 100).map((rows) => db.insert(schema.plannedSessionOverrides).values(rows)),
    ...chunk(newPlannedSessionAttachments, 100).map((rows) => db.insert(schema.plannedSessionAttachments).values(rows)),
    ...chunk(newMilestoneChecks, 100).map((rows) => db.insert(schema.milestoneChecks).values(rows)),
    ...chunk(newMaintenanceChecks, 100).map((rows) => db.insert(schema.maintenanceChecks).values(rows)),
    ...chunk(newMaintenanceItems, 100).map((rows) => db.insert(schema.maintenanceItems).values(rows)),
    ...chunk(newInspirationEntries, 100).map((rows) => db.insert(schema.inspirationEntries).values(rows)),
    ...chunk(newWeeklyNotes, 100).map((rows) => db.insert(schema.weeklyNotes).values(rows)),
    ...chunk(newBowSetups, 100).map((rows) => db.insert(schema.bowSetups).values(rows)),
    ...chunk(newEntries, 100).map((rows) => db.insert(schema.entries).values(rows)),
    ...chunk(newProgramState, 100).map((rows) => db.insert(schema.programState).values(rows)),
  ];
  if (statements.length > 0) {
    await (db as Db).batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }

  return c.json({
    ok: true,
    counts: {
      trainingSessions: newTrainingSessions.length,
      practiceScores: newPracticeScores.length,
      practiceScoreEnds: newPracticeScoreEnds.length,
      programState: newProgramState.length,
      cycleWeekPlans: newCycleWeekPlans.length,
      plannedSessionOverrides: newPlannedSessionOverrides.length,
      plannedSessionAttachments: newPlannedSessionAttachments.length,
      milestoneChecks: newMilestoneChecks.length,
      maintenanceChecks: newMaintenanceChecks.length,
      maintenanceItems: newMaintenanceItems.length,
      inspirationEntries: newInspirationEntries.length,
      weeklyNotes: newWeeklyNotes.length,
      bowSetups: newBowSetups.length,
      entries: newEntries.length,
    },
  });
});

export default transfer;
