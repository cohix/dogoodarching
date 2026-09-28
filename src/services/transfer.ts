// Export / import of one account's data (both roles).
//
// Export produces the version-1 JSON document. LIMITATION: file attachments
// (kind "document" | "photo") are EXCLUDED from the export — their blob bytes
// live in R2 and are not serialized; only link attachments are included.
// Import replaces ALL of the caller's data in a single D1 batch, remapping
// ids, and never touches other users' rows.

import { and, asc, eq, max, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { schema, type Db } from "../db";
import type { ImportData } from "../lib/validation";

export const EXPORT_VERSION = 1 as const;

export async function exportUserData(db: Db, userId: string, username: string) {
  const [
    sessionRows, scoreRows, endRows, stateRows, weekPlanRows, overrideRows, attachmentRows,
    milestoneRows, maintenanceRows, itemRows, inspirationRows, noteRows, setupRows,
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
  ]);
  const iso = (d: Date) => d.toISOString();
  const state = stateRows[0];
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    username,
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
    },
  };
}

/** Download filename for an export taken today. */
export function exportFilename(now: Date = new Date()): string {
  return `dga-export-${now.toISOString().slice(0, 10).replace(/-/g, "")}.json`;
}

// D1 limits each statement to 100 bind parameters, not 100 rows. Count the
// generated parameters, including remapped IDs and defaults, before batching.
function insertChunks<T>(rows: T[], insert: (rows: T[]) => BatchItem<"sqlite"> & { toSQL(): { params: unknown[] } }): BatchItem<"sqlite">[] {
  const out: BatchItem<"sqlite">[] = [];
  for (let offset = 0; offset < rows.length;) {
    let size = Math.min(100, rows.length - offset);
    let statement = insert(rows.slice(offset, offset + size));
    while (statement.toSQL().params.length > 100) {
      if (size === 1) throw new Error("An import row exceeds D1's bind limit");
      size = Math.floor(size / 2);
      statement = insert(rows.slice(offset, offset + size));
    }
    out.push(statement);
    offset += size;
  }
  return out;
}

export async function importUserData(db: Db, bucket: R2Bucket, userId: string, data: ImportData) {
  // Global high-water marks so remapped ids cannot collide with other users' rows.
  const [mSessions, mScores, mEnds, mNotes, mItems, mSetups, mInspiration, mAttachments] = await Promise.all([
    db.select({ m: max(schema.trainingSessions.id) }).from(schema.trainingSessions),
    db.select({ m: max(schema.practiceScores.id) }).from(schema.practiceScores),
    db.select({ m: max(schema.practiceScoreEnds.id) }).from(schema.practiceScoreEnds),
    db.select({ m: max(schema.weeklyNotes.id) }).from(schema.weeklyNotes),
    db.select({ m: max(schema.maintenanceItems.id) }).from(schema.maintenanceItems),
    db.select({ m: max(schema.bowSetups.id) }).from(schema.bowSetups),
    db.select({ m: max(schema.inspirationEntries.id) }).from(schema.inspirationEntries),
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
  await Promise.all(orphanBlobs.map((r) => bucket.delete(r.blobKey)));

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
    db.delete(schema.programState).where(eq(schema.programState.userId, userId)),
    ...insertChunks(newTrainingSessions, (rows) => db.insert(schema.trainingSessions).values(rows)),
    ...insertChunks(newPracticeScores, (rows) => db.insert(schema.practiceScores).values(rows)),
    ...insertChunks(newPracticeScoreEnds, (rows) => db.insert(schema.practiceScoreEnds).values(rows)),
    ...insertChunks(newCycleWeekPlans, (rows) => db.insert(schema.cycleWeekPlans).values(rows)),
    ...insertChunks(newPlannedSessionOverrides, (rows) => db.insert(schema.plannedSessionOverrides).values(rows)),
    ...insertChunks(newPlannedSessionAttachments, (rows) => db.insert(schema.plannedSessionAttachments).values(rows)),
    ...insertChunks(newMilestoneChecks, (rows) => db.insert(schema.milestoneChecks).values(rows)),
    ...insertChunks(newMaintenanceChecks, (rows) => db.insert(schema.maintenanceChecks).values(rows)),
    ...insertChunks(newMaintenanceItems, (rows) => db.insert(schema.maintenanceItems).values(rows)),
    ...insertChunks(newInspirationEntries, (rows) => db.insert(schema.inspirationEntries).values(rows)),
    ...insertChunks(newWeeklyNotes, (rows) => db.insert(schema.weeklyNotes).values(rows)),
    ...insertChunks(newBowSetups, (rows) => db.insert(schema.bowSetups).values(rows)),
    ...insertChunks(newProgramState, (rows) => db.insert(schema.programState).values(rows)),
  ];
  if (statements.length > 0) {
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }

  return {
    ok: true as const,
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
    },
  };
}
