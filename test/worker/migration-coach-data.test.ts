// 0007 team_meals and 0008 coach data removal (0003 §3, §5), replayed by hand
// on empty and populated databases. Each test rebuilds its own database.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashPassword } from "../../src/lib/auth";
import { runScheduledCleanup } from "../../src/services/cleanup";
import { apiJson, bootstrapCoach, DEFAULT_PASSWORD, login } from "./helpers";
import {
  applyMigration, columns, count, fkCheck, foreignKeys, indexNames, migration, rewindToBefore, userTables,
} from "./migration-fixtures";

/** Every personal table 0008 empties for coaches (children before parents). */
const PERSONAL_TABLES = [
  "practice_score_ends", "practice_scores", "training_sessions", "program_state", "cycle_week_plans", "planned_session_overrides",
  "planned_session_attachments", "milestone_checks", "maintenance_checks", "maintenance_items", "inspiration_entries", "weekly_notes",
  "bow_setups", "upload_reservations",
];

const NOW = Date.parse("2026-09-28T09:00:00Z");

function user(id: string, username: string, role: "coach" | "athlete", isOwner = false, passwordHash = "hash") {
  return env.DB.prepare("INSERT INTO users (id, username, password_hash, role, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, username, passwordHash, role, isOwner ? 1 : 0, NOW);
}

/** One row in every personal table for `userId` (post-0007 schema), with optional file attachments. */
async function seedPersonalRows(userId: string, idBase: number, blobKeys: string[] = []): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO training_sessions (id, user_id, session_date, session_type, arrows, notes, created_at) VALUES (?, ?, '2026-09-21', 'Range', 60, 'private', ?)").bind(idBase, userId, NOW),
    env.DB.prepare("INSERT INTO program_state (user_id, current_poundage, current_cycle, current_week, updated_at) VALUES (?, 24, 2, 6, ?)").bind(userId, NOW),
    env.DB.prepare("INSERT INTO cycle_week_plans (user_id, week_number, primary_focus, updated_at) VALUES (?, 1, 'Focus', ?)").bind(userId, NOW),
    env.DB.prepare("INSERT INTO planned_session_overrides (user_id, day_key, session_type, detail, prescription, updated_at) VALUES (?, 'mon', 'Range', 'Detail', 'Rx', ?)").bind(userId, NOW),
    env.DB.prepare("INSERT INTO planned_session_attachments (user_id, day_key, kind, label, url, created_at) VALUES (?, 'mon', 'link', 'Link', 'https://example.org', ?)").bind(userId, NOW),
    env.DB.prepare("INSERT INTO milestone_checks (user_id, key, checked, updated_at) VALUES (?, 'm1', 1, ?)").bind(userId, NOW),
    env.DB.prepare("INSERT INTO maintenance_checks (user_id, key, checked, updated_at) VALUES (?, 'c1', 1, ?)").bind(userId, NOW),
    env.DB.prepare("INSERT INTO maintenance_items (id, user_id, section, label, sort_order, created_at, updated_at) VALUES (?, ?, 'Weekly', 'Wax', 0, ?, ?)").bind(idBase, userId, NOW, NOW),
    env.DB.prepare("INSERT INTO inspiration_entries (id, user_id, thought_text, video_title, video_url, recipe_name, recipe_summary, recipe_ingredients, recipe_instructions, updated_at) VALUES (?, ?, 't', 'v', 'https://v', 'r', 's', 'i', 'm', ?)").bind(idBase, userId, NOW),
    env.DB.prepare("INSERT INTO weekly_notes (id, user_id, week_start, notes, created_at, updated_at) VALUES (?, ?, '2026-09-21', 'n', ?, ?)").bind(idBase, userId, NOW, NOW),
    env.DB.prepare("INSERT INTO practice_scores (id, user_id, score_date, total, created_at) VALUES (?, ?, '2026-09-21', 30, ?)").bind(idBase, userId, NOW),
    env.DB.prepare("INSERT INTO practice_score_ends (id, user_id, score_id, end_number, arrow_1, arrow_2, arrow_3, end_total) VALUES (?, ?, ?, 1, 10, 10, 10, 30)").bind(idBase, userId, idBase),
    env.DB.prepare("INSERT INTO bow_setups (id, user_id, poundage, name, updated_at) VALUES (?, ?, 30, 'Setup', ?)").bind(idBase, userId, NOW),
    ...blobKeys.map((key) => env.DB.prepare(
      "INSERT INTO planned_session_attachments (user_id, day_key, kind, label, blob_key, mime_type, size_bytes, created_at) VALUES (?, 'tue', 'document', 'File', ?, 'application/pdf', 3, ?)",
    ).bind(userId, key, NOW)),
  ]);
  for (const key of blobKeys) await env.ATTACHMENTS.put(key, new Uint8Array([1, 2, 3]));
}

function reservation(key: string, userId: string, actorId: string, expiresAt: number) {
  return env.DB.prepare("INSERT INTO upload_reservations (blob_key, user_id, actor_id, size_bytes, expires_at) VALUES (?, ?, ?, 3, ?)")
    .bind(key, userId, actorId, expiresAt);
}

/** Every row of every personal table, for byte-for-byte before/after comparisons. */
async function snapshot(where: string, ...binds: unknown[]): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of PERSONAL_TABLES) {
    result[table] = (await env.DB.prepare(`SELECT * FROM "${table}" WHERE ${where} ORDER BY rowid`).bind(...binds).all()).results;
  }
  return result;
}

async function r2Keys(): Promise<string[]> {
  return (await env.ATTACHMENTS.list()).objects.map((object) => object.key).sort();
}

describe("0007 team_meals", () => {
  it("creates team_meals with nullable SET NULL author/editor references and a created_at index", async () => {
    await rewindToBefore("0007");
    expect(await userTables()).not.toContain("team_meals");
    await applyMigration(migration("0007"));
    expect((await columns("team_meals")).map((c) => [c.name, c.notnull])).toEqual([
      ["id", 1], ["author_id", 0], ["updated_by", 0], ["name", 1], ["summary", 1], ["ingredients", 1], ["instructions", 1], ["created_at", 1], ["updated_at", 1],
    ]);
    const fks = (await foreignKeys("team_meals")).map((fk) => [fk.from, fk.table, fk.to, fk.on_delete]).sort();
    expect(fks).toEqual([["author_id", "users", "id", "SET NULL"], ["updated_by", "users", "id", "SET NULL"]]);
    expect(await indexNames("team_meals")).toContain("idx_team_meals_created_at");
    expect(await fkCheck()).toEqual([]);
  });
});

describe("0008 coach data removal", () => {
  it("is a no-op on an empty database and leaves the schema unchanged", async () => {
    await rewindToBefore("0008");
    const schemaBefore = (await env.DB.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).results;
    await applyMigration(migration("0008"));
    expect((await env.DB.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).results).toEqual(schemaBefore);
    for (const table of [...PERSONAL_TABLES, "users", "blob_cleanup", "team_meals"]) expect(await count(table), table).toBe(0);
    expect(await fkCheck()).toEqual([]);
    // The app works on top of it.
    const owner = await bootstrapCoach("first");
    expect((await apiJson("/api/coach/overview", { cookie: owner.cookie })).body).toEqual({ athletes: [] });
  });

  it("is a no-op when coaches have no personal data (athlete rows only)", async () => {
    await rewindToBefore("0008");
    await env.DB.batch([user("owner", "owner", "coach", true), user("coach2", "coach2", "coach"), user("ath-1", "ath1", "athlete")]);
    await seedPersonalRows("ath-1", 1, ["plans/ath-1/a.pdf"]);
    const before = await snapshot("1 = 1");
    await applyMigration(migration("0008"));
    expect(await snapshot("1 = 1")).toEqual(before);
    expect(await count("blob_cleanup")).toBe(0);
    expect(await count("users")).toBe(3);
    expect(await fkCheck()).toEqual([]);
  });

  it("removes every coach's personal rows, queues their file keys, and leaves athletes, coach uploads into athlete plans and team meals untouched", async () => {
    await rewindToBefore("0008");
    await env.DB.batch([
      user("owner", "owner", "coach", true), user("coach2", "coach2", "coach"), user("coach3", "coach3", "coach"),
      user("ath-1", "ath1", "athlete"), user("ath-2", "ath2", "athlete"),
    ]);
    // Owner and coach2 have rows in every personal table; the owner also has files. coach3 has none.
    await seedPersonalRows("owner", 1, ["plans/owner/own-1.pdf", "plans/owner/own-2.pdf"]);
    await seedPersonalRows("coach2", 2, ["plans/coach2/own.pdf"]);
    // Athletes: their own files, and a file coach2 uploaded into ath-1's plan (stored under the athlete).
    await seedPersonalRows("ath-1", 3, ["plans/ath-1/own.pdf", "plans/ath-1/from-coach2.pdf"]);
    await seedPersonalRows("ath-2", 4);
    // A coach-owned attachment row that shares its key with an athlete row is never queued.
    await env.DB.prepare("INSERT INTO planned_session_attachments (user_id, day_key, kind, label, blob_key, mime_type, created_at) VALUES ('owner', 'wed', 'document', 'Shared', 'plans/ath-1/own.pdf', 'application/pdf', ?)").bind(NOW).run();
    // Reservations: the owner's own in-flight upload (already queued by the upload path), coach2's abandoned
    // own upload, and coach2's in-flight upload into ath-1's plan (user = athlete, actor = coach).
    await env.ATTACHMENTS.put("plans/coach2/abandoned.pdf", new Uint8Array([9]));
    await env.DB.batch([
      reservation("plans/owner/in-flight.pdf", "owner", "owner", NOW - 1000),
      reservation("plans/coach2/abandoned.pdf", "coach2", "coach2", NOW - 1000),
      reservation("plans/ath-1/coach-in-flight.pdf", "ath-1", "coach2", NOW + 60_000),
      env.DB.prepare("INSERT INTO blob_cleanup (blob_key, reason, attempts, last_error, next_attempt_at, created_at) VALUES ('plans/owner/in-flight.pdf', 'upload', 2, 'earlier', ?, ?)").bind(NOW - 5000, NOW - 5000),
      env.DB.prepare("INSERT INTO team_meals (author_id, updated_by, name, created_at, updated_at) VALUES ('owner', 'coach2', 'Oats', ?, ?)").bind(NOW, NOW),
    ]);
    const athletesBefore = await snapshot("user_id IN ('ath-1', 'ath-2')");
    const usersBefore = (await env.DB.prepare("SELECT * FROM users ORDER BY id").all()).results;
    const mealsBefore = (await env.DB.prepare("SELECT * FROM team_meals").all()).results;
    for (const table of PERSONAL_TABLES) {
      if (table === "upload_reservations") continue;
      expect(await count(table, "user_id IN ('owner', 'coach2')"), `${table} seeded for coaches`).toBeGreaterThanOrEqual(2);
    }
    const startedAt = Date.now();

    await applyMigration(migration("0008"));

    // Coaches end with no personal rows at all.
    for (const table of PERSONAL_TABLES) {
      expect(await count(table, "user_id IN (SELECT id FROM users WHERE role = 'coach')"), table).toBe(0);
    }
    // Athlete rows (including the coach upload into ath-1's plan and its in-flight reservation) are byte-for-byte unchanged.
    expect(await snapshot("user_id IN ('ath-1', 'ath-2')")).toEqual(athletesBefore);
    expect(await count("upload_reservations", "actor_id = 'coach2' AND user_id = 'ath-1'")).toBe(1);
    expect((await env.DB.prepare("SELECT * FROM users ORDER BY id").all()).results).toEqual(usersBefore);
    expect((await env.DB.prepare("SELECT * FROM team_meals").all()).results).toEqual(mealsBefore);

    // Coach file keys are queued for the cron; the existing record keeps its state; athlete keys are not queued.
    const queued = (await env.DB.prepare("SELECT * FROM blob_cleanup ORDER BY blob_key").all<{
      blob_key: string; reason: string; attempts: number; last_error: string | null; next_attempt_at: number; created_at: number;
    }>()).results;
    expect(queued.map((row) => row.blob_key)).toEqual([
      "plans/coach2/abandoned.pdf", "plans/coach2/own.pdf", "plans/owner/in-flight.pdf", "plans/owner/own-1.pdf", "plans/owner/own-2.pdf",
    ]);
    for (const row of queued.filter((r) => r.blob_key !== "plans/owner/in-flight.pdf")) {
      expect(row).toMatchObject({ reason: "coach-data-removal", attempts: 0, last_error: null });
      expect(row.next_attempt_at).toBe(row.created_at);
      expect(row.created_at).toBeGreaterThanOrEqual(startedAt - 1000);
      expect(row.created_at).toBeLessThanOrEqual(Date.now() + 1000);
    }
    expect(queued.find((r) => r.blob_key === "plans/owner/in-flight.pdf")).toMatchObject({ reason: "upload", attempts: 2, last_error: "earlier", next_attempt_at: NOW - 5000 });
    expect(await fkCheck()).toEqual([]);

    // The scheduled job removes the coaches' R2 objects and never the athletes'.
    const report = await runScheduledCleanup(env);
    expect(report.blobs.failed).toBe(0);
    expect(await r2Keys()).toEqual(["plans/ath-1/from-coach2.pdf", "plans/ath-1/own.pdf"]);
    expect(await count("blob_cleanup")).toBe(0);
    expect(await snapshot("user_id IN ('ath-1', 'ath-2')")).toEqual(athletesBefore);
  });

  it("the migrated database still serves athletes and coaches through the Worker", async () => {
    await rewindToBefore("0008");
    const hash = await hashPassword(DEFAULT_PASSWORD);
    await env.DB.batch([user("owner", "owner", "coach", true, hash), user("ath-1", "ath1", "athlete", false, hash)]);
    await seedPersonalRows("owner", 1);
    await seedPersonalRows("ath-1", 2);
    await applyMigration(migration("0008"));
    expect(await fkCheck()).toEqual([]);
    const owner = await login("owner");
    const athlete = await login("ath1");
    // A stale coach client calling a personal route gets 403, not 500.
    expect((await apiJson("/api/tracker", { cookie: owner.cookie })).status).toBe(403);
    const tracker = await apiJson<{ state: { currentPoundage: number | null }; sessions: unknown[] }>("/api/tracker?today=2026-09-28", { cookie: athlete.cookie });
    expect(tracker.status).toBe(200);
    expect(tracker.body.state.currentPoundage).toBe(24);
    expect(tracker.body.sessions).toHaveLength(1);
    const overview = await apiJson<{ athletes: Array<{ id: string; currentPoundage: number | null; cycleSessions: number }> }>("/api/coach/overview?today=2026-09-28", { cookie: owner.cookie });
    expect(overview.body.athletes.map((a) => [a.id, a.currentPoundage, a.cycleSessions])).toEqual([["ath-1", 24, 1]]);
  });
});
