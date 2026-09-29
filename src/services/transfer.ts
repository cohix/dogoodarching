// Export / import of one account's data (both roles).
//
// Export produces the version-1 JSON document. LIMITATION: file attachments
// (kind "document" | "photo") are EXCLUDED from the export — their blob bytes
// live in R2 and are not serialized; only link attachments are included.
// Import replaces ALL of the caller's data in a single D1 batch, remapping
// ids, and never touches other users' rows.

import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { schema, type Db } from "../db";
import { importPayloadSchema, type ImportData } from "../lib/validation";
import { UserFacingError, zodErrorMessage } from "../lib/http";
import { attemptBlobCleanup, enqueueBlobCleanupFromAttachments } from "./cleanup";

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

// Portably fits the Free plan's 50-query invocation ceiling, leaving ten
// queries for authentication and a bounded prompt cleanup attempt. Paid uses
// the same limit. Never split a replacement across committed batches.
export const MAX_IMPORT_BYTES = 8_000_000;
export const MAX_IMPORT_STATEMENTS = 40;
export const MAX_IMPORT_SQL_BYTES = 100_000;
export const MAX_IMPORT_VALUE_BYTES = 128_000;
const MAX_CHUNK_ROWS = 1_000;
const encoder = new TextEncoder();
type ImportRow = Record<string, string | number | boolean | null>;
type Statement = BatchItem<"sqlite"> & { toSQL(): { sql: string; params: unknown[] } };

/** Complete preflight before any write, including cleanup enqueue/deletes. */
export function preflightImport(statements: readonly { sql: string; params: unknown[] }[]): void {
  if (statements.length > MAX_IMPORT_STATEMENTS) throw new UserFacingError(413, `Import exceeds the ${MAX_IMPORT_STATEMENTS}-statement atomic batch budget; reduce the exported history`);
  for (const statement of statements) {
    if (encoder.encode(statement.sql).length > MAX_IMPORT_SQL_BYTES || statement.params.length > 100) {
      throw new UserFacingError(413, "Import exceeds the SQL statement budget");
    }
    for (const value of statement.params) {
      if (typeof value === "string" && encoder.encode(value).length > MAX_IMPORT_VALUE_BYTES) {
        throw new UserFacingError(413, "Import value exceeds 128000 bytes");
      }
    }
  }
}

function jsonChunks(rows: ImportRow[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let bytes = 2;
  for (const row of rows) {
    const text = JSON.stringify(row);
    const size = encoder.encode(text).length;
    if (size + 2 > MAX_IMPORT_VALUE_BYTES) throw new UserFacingError(413, "Import row exceeds 128000 bytes");
    if (current.length && (bytes + size + 1 > MAX_IMPORT_VALUE_BYTES || current.length >= MAX_CHUNK_ROWS)) {
      chunks.push(`[${current.join(",")}]`);
      current = [];
      bytes = 2;
    }
    current.push(text);
    bytes += size + 1;
  }
  if (current.length) chunks.push(`[${current.join(",")}]`);
  return chunks;
}

export async function importUserData(db: Db, bucket: R2Bucket, userId: string, supplied: ImportData) {
  // Services also validate: direct callers must not bypass HTTP invariants.
  const validated = importPayloadSchema.safeParse({ version: 1, data: supplied });
  if (!validated.success) throw new UserFacingError(400, zodErrorMessage(validated.error, true));
  const data = validated.data.data;
  const importId = crypto.randomUUID();
  const active = sql`EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND deactivated_at IS NULL)`;
  const tables = {
    practiceScoreEnds: schema.practiceScoreEnds,
    practiceScores: schema.practiceScores,
    plannedSessionAttachments: schema.plannedSessionAttachments,
    plannedSessionOverrides: schema.plannedSessionOverrides,
    cycleWeekPlans: schema.cycleWeekPlans,
    trainingSessions: schema.trainingSessions,
    milestoneChecks: schema.milestoneChecks,
    maintenanceChecks: schema.maintenanceChecks,
    maintenanceItems: schema.maintenanceItems,
    inspirationEntries: schema.inspirationEntries,
    weeklyNotes: schema.weeklyNotes,
    bowSetups: schema.bowSetups,
    programState: schema.programState,
  };
  const statements: Statement[] = [
    db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, userId), active)),
    enqueueBlobCleanupFromAttachments(db, and(eq(schema.plannedSessionAttachments.userId, userId), active)!, { reason: "import" })
      .returning({ blobKey: schema.blobCleanup.blobKey }),
    ...Object.values(tables).map((table) => db.delete(table).where(and(eq(table.userId, userId), active))),
  ];
  // Parents first. Each parent has an unambiguous import UUID/source-id key;
  // children resolve it inside this same batch. No connection-local state or
  // precomputed database IDs, and duplicate dates/labels are allowed.
  const order = ["trainingSessions", "practiceScores", "maintenanceItems", "practiceScoreEnds", "maintenanceChecks",
    "cycleWeekPlans", "plannedSessionOverrides", "plannedSessionAttachments", "milestoneChecks",
    "inspirationEntries", "weeklyNotes", "bowSetups", "programState"] as const;
  for (const name of order) {
    const table = tables[name];
    const collection = name === "programState" ? (data.programState ? [data.programState] : []) : data[name];
    const rows: ImportRow[] = collection.map((row) => {
      const result: ImportRow = { ...row, userId };
      delete result.id;
      for (const field of ["createdAt", "updatedAt"]) {
        if (typeof result[field] === "string") result[field] = Date.parse(result[field]);
      }
      if (name === "practiceScores" || name === "maintenanceItems") result.importKey = `${importId}:${"id" in row ? row.id : ""}`;
      if (name === "plannedSessionAttachments") result.blobKey = "";
      return result;
    });
    const columns = Object.keys(getTableColumns(table));
    const projections = columns.map((field) => {
      // All field names are trusted schema identifiers, never request input.
      const value = sql`json_extract(incoming.value, ${`$.${field}`})`;
      if (name === "practiceScoreEnds" && field === "scoreId") {
        return sql`(SELECT id FROM practice_scores WHERE user_id = ${userId} AND import_key = ${importId + ":"} || ${value})`;
      }
      if (name === "maintenanceChecks" && field === "key") {
        return sql`CASE WHEN ${value} GLOB 'item:[0-9]*' AND substr(${value}, 6) NOT GLOB '*[^0-9]*'
          THEN 'item:' || (SELECT id FROM maintenance_items WHERE user_id = ${userId}
            AND import_key = ${importId + ":"} || CAST(substr(${value}, 6) AS INTEGER)) ELSE ${value} END`;
      }
      return value;
    });
    for (const chunk of jsonChunks(rows)) {
      statements.push(db.insert(table).select(sql`SELECT ${sql.join(projections, sql`, `)} FROM json_each(${chunk}) AS incoming WHERE ${active}`));
    }
  }
  for (const table of [schema.practiceScores, schema.maintenanceItems]) {
    statements.push(db.update(table).set({ importKey: null }).where(and(eq(table.userId, userId), active)));
  }
  preflightImport(statements.map((statement) => statement.toSQL()));
  const result = await db.batch(statements as [Statement, ...Statement[]]);
  if (!(result[0] as { id: string }[]).length) throw new UserFacingError(401, "Import account is no longer available");
  // The queue contains the exact rows removed, including concurrent uploads.
  // Only one prompt attempt fits our portable query budget; cron handles the
  // remainder. Cleanup failure must never turn a committed import into failure.
  const queued = result[1] as { blobKey: string }[];
  try {
    if (queued.length) await attemptBlobCleanup(db, bucket, [queued[0].blobKey]);
  } catch { console.error("Import cleanup deferred"); }
  return { ok: true as const, counts: Object.fromEntries(Object.entries(data).map(([name, rows]) =>
    [name, Array.isArray(rows) ? rows.length : rows ? 1 : 0])) };
}
