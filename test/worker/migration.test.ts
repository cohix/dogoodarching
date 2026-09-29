// Schema migrations: 0001 → 0002 on an empty DB, on a seeded 0001 DB, on a DB
// with no coach, and the documented orphan handling. Each test rebuilds its
// own database from scratch, so the order of tests does not matter.
import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashPassword, sha256Hex } from "../../src/lib/auth";
import { datedProgramState } from "../../src/lib/dates";
import { DEFAULT_PROGRAM_STATE } from "../../src/services/plan";
import { apiJson, bootstrapCoach, login, DEFAULT_PASSWORD } from "./helpers";
import {
  applyLaterMigrations, applyMigration, columnNames, columns, count, dropEverything, fkCheck, foreignKeys, indexNames, migration, rewindTo0001, scalar, user0001, userTables,
} from "./migration-fixtures";

const DAY = 86400000;

/** Old fallback state (pre-0002) that every user without a program_state row used to see. */
const LEGACY_FALLBACK = { currentPoundage: 24, currentCycle: 2, currentWeek: 6 } as const;

const TRACKER_TABLES = [
  "training_sessions", "program_state", "cycle_week_plans", "planned_session_overrides", "planned_session_attachments",
  "milestone_checks", "maintenance_checks", "maintenance_items", "inspiration_entries", "weekly_notes", "practice_scores",
  "practice_score_ends", "bow_setups",
];

async function seedTrackerRows(userId: string, now: number, idBase: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO training_sessions (id, user_id, session_date, session_type, arrows, created_at) VALUES (?, ?, '2026-09-21', 'Range', 60, ?)").bind(idBase, userId, now),
    env.DB.prepare("INSERT INTO cycle_week_plans VALUES (?, 1, 'Focus', '', '', ?)").bind(userId, now),
    env.DB.prepare("INSERT INTO planned_session_overrides VALUES (?, 'mon', 'Range', 'Detail', 'Rx', ?)").bind(userId, now),
    env.DB.prepare("INSERT INTO planned_session_attachments (id, user_id, day_key, kind, label, url, blob_key, mime_type, created_at) VALUES (?, ?, 'mon', 'link', 'L', 'https://x', '', 'text/uri-list', ?)").bind(idBase, userId, now),
    env.DB.prepare("INSERT INTO milestone_checks VALUES (?, 'm1', 1, ?)").bind(userId, now),
    env.DB.prepare("INSERT INTO maintenance_checks VALUES (?, 'c1', 0, ?)").bind(userId, now),
    env.DB.prepare("INSERT INTO maintenance_items (id, user_id, section, label, sort_order, created_at, updated_at) VALUES (?, ?, 'Weekly', 'Wax', 0, ?, ?)").bind(idBase, userId, now, now),
    env.DB.prepare("INSERT INTO inspiration_entries (id, user_id, thought_text, video_title, video_url, recipe_name, recipe_summary, recipe_ingredients, recipe_instructions, updated_at) VALUES (?, ?, 't', 'v', 'https://v', 'r', 's', 'i', '', ?)").bind(idBase, userId, now),
    env.DB.prepare("INSERT INTO weekly_notes (id, user_id, week_start, notes, created_at, updated_at) VALUES (?, ?, '2026-09-21', 'n', ?, ?)").bind(idBase, userId, now, now),
    env.DB.prepare("INSERT INTO practice_scores (id, user_id, score_date, total, created_at) VALUES (?, ?, '2026-09-21', 30, ?)").bind(idBase, userId, now),
    env.DB.prepare("INSERT INTO practice_score_ends (id, user_id, score_id, end_number, arrow_1, arrow_2, arrow_3, end_total) VALUES (?, ?, ?, 1, 10, 10, 10, 30)").bind(idBase, userId, idBase),
    env.DB.prepare("INSERT INTO bow_setups (id, user_id, poundage, name, updated_at) VALUES (?, ?, 30, 'Setup', ?)").bind(idBase, userId, now),
    env.DB.prepare("INSERT INTO entries (user_id, text, created_at) VALUES (?, 'legacy', ?)").bind(userId, now),
  ]);
}

describe("migrations on an empty database", () => {
  it("0001 then 0002 apply cleanly and produce the schema the app expects", async () => {
    await rewindTo0001();
    expect(await columnNames("users")).toEqual(["id", "username", "password_hash", "role", "coach_id", "created_at"]);
    expect(await userTables()).toContain("entries");

    await applyMigration(migration("0002"));

    const tables = await userTables();
    expect(tables).not.toContain("entries");
    expect(tables.filter((name) => name.startsWith("__"))).toEqual([]); // no temp tables left behind
    expect(tables).toEqual(expect.arrayContaining(["users", "sessions", "invites", "rate_limits", ...TRACKER_TABLES]));

    expect(await columnNames("users")).toEqual(["id", "username", "password_hash", "role", "is_owner", "invited_by", "created_at"]);
    expect(await columnNames("invites")).toEqual(["id", "token_hash", "created_by", "role", "expires_at", "used_at", "created_at"]);
    const programState = await columns("program_state");
    expect(programState.find((c) => c.name === "current_poundage")?.notnull).toBe(0); // nullable now
    expect((await columns("users")).find((c) => c.name === "id")?.notnull).toBe(1);
    expect((await columns("invites")).find((c) => c.name === "role")?.dflt_value).toBe("'athlete'");
    expect((await columns("users")).find((c) => c.name === "is_owner")?.dflt_value).toMatch(/^(false|0)$/);

    // Every user_id column is a cascading FK to users; provenance columns SET NULL.
    for (const table of ["sessions", ...TRACKER_TABLES]) {
      const fk = (await foreignKeys(table)).find((f) => f.from === "user_id");
      expect(fk, `${table}.user_id`).toMatchObject({ table: "users", to: "id", on_delete: "CASCADE" });
    }
    expect((await foreignKeys("practice_score_ends")).find((f) => f.from === "score_id")).toMatchObject({ table: "practice_scores", on_delete: "CASCADE" });
    expect((await foreignKeys("users")).find((f) => f.from === "invited_by")).toMatchObject({ table: "users", to: "id", on_delete: "SET NULL" });
    expect((await foreignKeys("invites")).find((f) => f.from === "created_by")).toMatchObject({ table: "users", to: "id", on_delete: "SET NULL" });

    // Indexes from schema.ts exist under their declared names.
    expect(await indexNames("users")).toEqual(expect.arrayContaining(["users_username_unique", "users_username_ci_unique", "users_one_owner_unique"]));
    expect(await indexNames("invites")).toEqual(expect.arrayContaining(["invites_token_hash_unique", "idx_invites_created_by"]));
    expect(await indexNames("sessions")).toEqual(expect.arrayContaining(["sessions_token_hash_unique", "idx_sessions_user"]));
    expect(await indexNames("weekly_notes")).toContain("weekly_notes_user_week_unique");
    for (const table of TRACKER_TABLES) {
      if (table === "program_state") continue; // user_id is its primary key
      expect(await indexNames(table), table).toContain(`idx_${table}_user`);
    }
    expect(await indexNames("practice_score_ends")).toContain("idx_practice_score_ends_score");
    expect(await fkCheck()).toEqual([]);

    // The Worker runs against the fully migrated schema: bootstrap works.
    await applyLaterMigrations();
    const owner = await bootstrapCoach("first");
    expect(owner.user.isOwner).toBe(true);
    expect((await apiJson("/api/auth/me", { cookie: owner.cookie })).body).toEqual(owner.user);
  });

  it("the replayed schema matches the harness-applied schema exactly", async () => {
    const dump = () => env.DB.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY type, name").all();
    // Earlier tests in this file replay migrations by hand, so rebuild the
    // baseline with the harness's own runner instead of trusting current state.
    await dropEverything();
    await env.DB.prepare("DELETE FROM d1_migrations").run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const fromHarness = (await dump()).results;
    await rewindTo0001();
    await applyMigration(migration("0002"));
    expect(await userTables()).toContain("rate_limits"); // still present until 0003
    await applyMigration(migration("0003"));
    expect(await userTables()).not.toContain("rate_limits");
    expect(await columnNames("users")).not.toContain("deactivated_at"); // added by 0004
    await applyMigration(migration("0004"));
    expect(await columnNames("users")).toContain("deactivated_at");
    expect(await userTables()).toContain("blob_cleanup");
    await applyMigration(migration("0005"));
    await applyMigration(migration("0006"));
    expect(await userTables()).not.toContain("team_meals"); // added by 0007
    await applyMigration(migration("0007"));
    expect(await userTables()).toContain("team_meals");
    await applyMigration(migration("0008")); // data only: no schema change
    expect((await dump()).results).toEqual(fromHarness);
  });

  it("only the eight known migrations exist and all are applied by the harness", async () => {
    const names = ["0001_init.sql", "0002_team_auth.sql", "0003_drop_rate_limits.sql", "0004_lifecycle.sql", "0005_upload_accounting.sql",
      "0006_import_mapping.sql", "0007_team_meals.sql", "0008_coach_data_removal.sql"];
    expect(env.TEST_MIGRATIONS.map((m) => m.name)).toEqual(names);
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(names);
  });
});

describe("0002 on a database seeded with 0001 data", () => {
  it("marks the coach as owner, copies coach_id into invited_by, drops entries, backfills program_state and keeps every valid row", async () => {
    await rewindTo0001();
    const now = Date.now();
    const oldAnchor = Date.parse("2026-08-03T09:00:00Z"); // a Monday, several weeks back
    const coachHash = await hashPassword(DEFAULT_PASSWORD);
    const athleteHash = await hashPassword(DEFAULT_PASSWORD);
    const sessionToken = "a".repeat(64);
    await env.DB.batch([
      user0001("coach", "coach", "coach", null, now - 10 * DAY, coachHash),
      user0001("ath-1", "ath1", "athlete", "coach", now - 9 * DAY, athleteHash),
      user0001("ath-2", "ath2", "athlete", "coach", now - 8 * DAY),
      user0001("ath-3", "ath3", "athlete", "deleted-coach", now - 7 * DAY, athleteHash), // coach_id points at a missing user
      // ath-1 has a saved program state; ath-2, ath-3 and the coach have none.
      env.DB.prepare("INSERT INTO program_state VALUES ('ath-1', 32, 3, 4, ?)").bind(oldAnchor),
      env.DB.prepare("INSERT INTO invites VALUES ('inv-1', 'th1', 'coach', ?, NULL, ?)").bind(now + DAY, now),
      env.DB.prepare("INSERT INTO invites VALUES ('inv-used', 'th2', 'coach', ?, ?, ?)").bind(now + DAY, now - 1000, now - 2000),
      env.DB.prepare("INSERT INTO invites VALUES ('inv-orphan', 'th3', 'deleted-coach', ?, NULL, ?)").bind(now + DAY, now),
      env.DB.prepare("INSERT INTO sessions VALUES ('sess-1', ?, 'ath-1', ?, ?)").bind(await sha256Hex(sessionToken), now + 20 * DAY, now),
      env.DB.prepare("INSERT INTO entries (user_id, text, created_at) VALUES ('coach', 'note', ?)").bind(now),
    ]);
    await seedTrackerRows("ath-1", now, 1);
    await seedTrackerRows("ath-3", now, 2);
    await env.DB.prepare("INSERT INTO entries (user_id, text, created_at) VALUES ('ath-1', 'another', ?)").bind(now).run();
    const before: Record<string, number> = {};
    for (const table of TRACKER_TABLES) before[table] = await count(table);

    await applyMigration(migration("0002"));

    // Team model columns.
    expect(await scalar<number>("SELECT is_owner FROM users WHERE id = 'coach'")).toBe(1);
    expect(await count("users", "is_owner = 1")).toBe(1);
    expect(await scalar<string>("SELECT invited_by FROM users WHERE id = 'ath-1'")).toBe("coach");
    expect(await scalar<string>("SELECT invited_by FROM users WHERE id = 'ath-2'")).toBe("coach");
    expect(await scalar<string>("SELECT invited_by FROM users WHERE id = 'ath-3'")).toBeNull(); // missing target → NULL
    expect(await scalar<string>("SELECT invited_by FROM users WHERE id = 'coach'")).toBeNull();
    expect(await count("users")).toBe(4);
    expect(await columnNames("users")).not.toContain("coach_id");
    // Password hashes and usernames are byte-for-byte preserved.
    expect(await scalar<string>("SELECT password_hash FROM users WHERE id = 'coach'")).toBe(coachHash);

    // Invites: renamed column, role defaults to athlete, used_at preserved, orphan creator → NULL.
    expect(await scalar<string>("SELECT created_by FROM invites WHERE id = 'inv-1'")).toBe("coach");
    expect(await scalar<string>("SELECT role FROM invites WHERE id = 'inv-1'")).toBe("athlete");
    expect(await scalar<number>("SELECT used_at FROM invites WHERE id = 'inv-used'")).toBe(now - 1000);
    expect(await scalar<string>("SELECT created_by FROM invites WHERE id = 'inv-orphan'")).toBeNull();
    expect(await count("invites")).toBe(3);

    // entries is gone; every other valid row survived with its id.
    expect(await userTables()).not.toContain("entries");
    for (const table of TRACKER_TABLES) {
      if (table === "program_state") continue;
      expect(await count(table), table).toBe(before[table]);
    }
    expect(await scalar<number>("SELECT id FROM practice_score_ends WHERE user_id = 'ath-3'")).toBe(2);
    expect(await scalar<number>("SELECT score_id FROM practice_score_ends WHERE user_id = 'ath-3'")).toBe(2);
    expect(await scalar<number>("SELECT sort_order FROM maintenance_items WHERE user_id = 'ath-1'")).toBe(0);
    expect(await fkCheck()).toEqual([]);

    // program_state: saved rows untouched; everyone else backfilled to the legacy fallback anchored at migration time.
    expect(await env.DB.prepare("SELECT * FROM program_state WHERE user_id = 'ath-1'").first()).toEqual({
      user_id: "ath-1", current_poundage: 32, current_cycle: 3, current_week: 4, updated_at: oldAnchor,
    });
    for (const id of ["ath-2", "ath-3", "coach"]) {
      const row = await env.DB.prepare("SELECT * FROM program_state WHERE user_id = ?").bind(id).first<{ current_poundage: number; current_cycle: number; current_week: number; updated_at: number }>();
      expect(row, id).toMatchObject({ current_poundage: 24, current_cycle: 2, current_week: 6 });
      expect(Math.abs(row!.updated_at - now), `${id} anchor`).toBeLessThan(10_000);
      // What the user saw before: the old per-request fallback anchored at "now".
      for (const offset of [-1, 0, 1, 7, 30]) {
        const today = new Date(now + offset * DAY).toISOString().slice(0, 10);
        expect(
          datedProgramState({ currentCycle: row!.current_cycle, currentWeek: row!.current_week, updatedAt: new Date(row!.updated_at) }, today),
          `${id} on ${today}`,
        ).toEqual(datedProgramState({ currentCycle: LEGACY_FALLBACK.currentCycle, currentWeek: LEGACY_FALLBACK.currentWeek, updatedAt: new Date(now) }, today));
      }
    }
    expect(await count("program_state")).toBe(4);

    await applyLaterMigrations("0007");
    expect(await count("program_state", "user_id = 'coach'")).toBe(1);
    await applyMigration(migration("0008")); // the Worker needs the full schema
    // 0008 (0003 §5) removes the coach's backfilled personal row; athletes keep theirs.
    expect(await count("program_state", "user_id = 'coach'")).toBe(0);
    expect(await count("program_state")).toBe(3);
    expect(await fkCheck()).toEqual([]);
    // End to end: the existing session cookie still works and the tracker shows the same state as before.
    const cookie = `dga_session=${sessionToken}`;
    const me = await apiJson<{ id: string; isOwner: boolean }>("/api/auth/me", { cookie });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: "ath-1", isOwner: false });
    const today = new Date(now).toISOString().slice(0, 10);
    const tracker = await apiJson<{ state: { currentPoundage: number | null; currentCycle: number; currentWeek: number } }>(`/api/tracker?today=${today}`, { cookie });
    expect(tracker.body.state).toEqual({ currentPoundage: 32, ...datedProgramState({ currentCycle: 3, currentWeek: 4, updatedAt: new Date(oldAnchor) }, today) });

    const ath3 = await login("ath3");
    expect(ath3.user.isOwner).toBe(false);
    const tracker3 = await apiJson<{ state: { currentPoundage: number | null; currentCycle: number; currentWeek: number } }>(`/api/tracker?today=${today}`, { cookie: ath3.cookie });
    expect(tracker3.body.state).toEqual(LEGACY_FALLBACK);
    const coach = await login("coach");
    expect(coach.user.isOwner).toBe(true);
    // The migrated coach can invite coaches (owner) and sees every athlete.
    expect((await apiJson("/api/auth/invites", { json: { role: "coach" }, cookie: coach.cookie })).status).toBe(201);
    const roster = await apiJson<{ athletes: Array<{ id: string }> }>("/api/coach/athletes", { cookie: coach.cookie });
    expect(roster.body.athletes.map((a) => a.id).sort()).toEqual(["ath-1", "ath-2", "ath-3"]);
    // A brand-new user after the migration gets the new defaults, not the backfill.
    const newcomer = await apiJson<{ token: string }>("/api/auth/invites", { json: {}, cookie: coach.cookie });
    const accepted = await apiJson<{ id: string }>("/api/auth/accept-invite", { json: { token: newcomer.body.token, username: "fresh", password: DEFAULT_PASSWORD } });
    expect(accepted.status).toBe(201);
    expect(await count("program_state", "user_id = ?", accepted.body.id)).toBe(0);
    const freshTracker = await apiJson<{ state: unknown }>(`/api/tracker?today=${today}`, { cookie: (await login("fresh")).cookie });
    expect(freshTracker.body.state).toEqual(DEFAULT_PROGRAM_STATE);
  });

  it("AUTOINCREMENT sequences are carried over under the real table names and new ids stay above every retained row", async () => {
    // Note: 0002 rebuilds each table by copying retained rows, so the sequence
    // restarts at the highest *retained* id. Ids that belonged only to discarded
    // orphan rows can be reused; nothing references them, so that is harmless.
    await rewindTo0001();
    const now = Date.now();
    await env.DB.batch([user0001("coach", "coach", "coach", null, now), user0001("ath-1", "ath1", "athlete", "coach", now)]);
    await seedTrackerRows("ath-1", now, 7);
    await seedTrackerRows("orphan", now, 9); // will be discarded; its ids were the highest
    await applyMigration(migration("0002"));
    const { results } = await env.DB.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all<{ name: string; seq: number }>();
    expect(results.map((r) => r.name)).not.toContain(expect.stringMatching(/^__/));
    for (const table of ["training_sessions", "practice_scores", "practice_score_ends", "maintenance_items", "weekly_notes", "bow_setups", "inspiration_entries", "planned_session_attachments"]) {
      expect(results.find((r) => r.name === table)?.seq, table).toBeGreaterThanOrEqual(7);
    }
    await env.DB.prepare("INSERT INTO training_sessions (user_id, session_date, session_type, created_at) VALUES ('ath-1', '2026-09-28', 'Range', ?)").bind(now).run();
    expect(await scalar<number>("SELECT max(id) FROM training_sessions")).toBe(8);
    await env.DB.prepare("INSERT INTO practice_scores (user_id, score_date, total, created_at) VALUES ('ath-1', '2026-09-28', 1, ?)").bind(now).run();
    expect(await scalar<number>("SELECT max(id) FROM practice_scores")).toBe(8);
  });

  it("with several coaches (nonstandard 0001 data) exactly one, the earliest, becomes the owner", async () => {
    await rewindTo0001();
    const now = Date.now();
    await env.DB.batch([
      user0001("coach-late", "late", "coach", null, now),
      user0001("coach-early", "early", "coach", null, now - DAY),
      user0001("coach-mid", "mid", "coach", null, now - 1000),
    ]);
    await applyMigration(migration("0002"));
    expect(await count("users", "is_owner = 1")).toBe(1);
    expect(await scalar<string>("SELECT id FROM users WHERE is_owner = 1")).toBe("coach-early");
    // The partial unique index enforces a single owner from now on.
    await expect(env.DB.prepare("UPDATE users SET is_owner = 1 WHERE id = 'coach-late'").run()).rejects.toThrow(/UNIQUE/i);
    expect(await count("users", "is_owner = 1")).toBe(1);
  });

  it("case-insensitive username uniqueness still holds after the rebuild", async () => {
    await rewindTo0001();
    await user0001("coach", "Coach", "coach", null, Date.now()).run();
    await applyMigration(migration("0002"));
    await expect(env.DB.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('dup', 'COACH', 'h', 'athlete', 1)").run()).rejects.toThrow(/UNIQUE/i);
    await expect(env.DB.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('dup2', 'Coach', 'h', 'athlete', 1)").run()).rejects.toThrow(/UNIQUE/i);
    expect(await count("users")).toBe(1);
  });
});

describe("0002 on a database with no coach", () => {
  it("an empty database migrates with no owner and lets the first coach bootstrap afterwards", async () => {
    await rewindTo0001();
    await applyMigration(migration("0002"));
    expect(await count("users")).toBe(0);
    expect(await count("program_state")).toBe(0);
    expect(await fkCheck()).toEqual([]);
    await applyLaterMigrations();
    const owner = await bootstrapCoach("first");
    expect(owner.user.isOwner).toBe(true);
  });

  it("athletes only (their coach row missing) migrate with invited_by NULL, no owner, and are backfilled", async () => {
    await rewindTo0001();
    const now = Date.now();
    await env.DB.batch([
      user0001("ath-1", "ath1", "athlete", "gone-coach", now),
      user0001("ath-2", "ath2", "athlete", null, now),
      env.DB.prepare("INSERT INTO invites VALUES ('inv', 'th', 'gone-coach', ?, NULL, ?)").bind(now + DAY, now),
    ]);
    await applyMigration(migration("0002"));
    expect(await count("users")).toBe(2);
    expect(await count("users", "is_owner = 1")).toBe(0);
    expect(await scalar<string>("SELECT invited_by FROM users WHERE id = 'ath-1'")).toBeNull();
    expect(await scalar<string>("SELECT invited_by FROM users WHERE id = 'ath-2'")).toBeNull();
    expect(await scalar<string>("SELECT created_by FROM invites WHERE id = 'inv'")).toBeNull();
    expect(await count("program_state", "current_poundage = 24 AND current_cycle = 2 AND current_week = 6")).toBe(2);
    expect(await fkCheck()).toEqual([]);
  });
});

describe("0002 orphan handling (as documented in the migration header)", () => {
  it("discards rows whose user_id has no user, keeps everything owned by real users, and nulls broken inviter references", async () => {
    await rewindTo0001();
    const now = Date.now();
    await env.DB.batch([
      user0001("coach", "coach", "coach", null, now),
      user0001("ath-1", "ath1", "athlete", "coach", now),
      env.DB.prepare("INSERT INTO sessions VALUES ('s-ok', 'h1', 'ath-1', ?, ?)").bind(now + DAY, now),
      env.DB.prepare("INSERT INTO sessions VALUES ('s-orphan', 'h2', 'nobody', ?, ?)").bind(now + DAY, now),
      env.DB.prepare("INSERT INTO program_state VALUES ('nobody', 24, 2, 6, ?)").bind(now),
    ]);
    await seedTrackerRows("ath-1", now, 1);
    await seedTrackerRows("nobody", now, 2);
    await applyMigration(migration("0002"));

    for (const table of [...TRACKER_TABLES, "sessions"]) {
      expect(await count(table, "user_id = 'nobody'"), `${table} orphans`).toBe(0);
    }
    for (const table of TRACKER_TABLES) {
      expect(await count(table, "user_id = 'ath-1'"), `${table} for ath-1`).toBe(1);
    }
    expect(await count("sessions")).toBe(1);
    expect(await count("practice_score_ends")).toBe(1); // the orphan score's end went with its parent
    expect(await scalar<number>("SELECT id FROM practice_score_ends")).toBe(1);
    expect(await scalar<number>("SELECT score_id FROM practice_score_ends")).toBe(1);
    expect(await count("program_state", "user_id = 'nobody'")).toBe(0);
    expect(await fkCheck()).toEqual([]);

    // And from now on the FKs enforce themselves.
    await expect(env.DB.prepare("INSERT INTO training_sessions (user_id, session_date, session_type, created_at) VALUES ('ghost', '2026-09-28', 'Range', 1)").run()).rejects.toThrow(/FOREIGN KEY/i);
    await env.DB.prepare("DELETE FROM users WHERE id = 'ath-1'").run();
    for (const table of [...TRACKER_TABLES, "sessions"]) expect(await count(table, "user_id = 'ath-1'"), `${table} after cascade`).toBe(0);
    expect(await count("program_state")).toBe(1); // the coach's backfilled row remains
    expect(await scalar<string>("SELECT invited_by FROM users WHERE id = 'coach'")).toBeNull();
  });

  it("fails loudly (and leaves the 0001 schema in place) on a users row with a NULL id", async () => {
    await rewindTo0001();
    const now = Date.now();
    await env.DB.batch([
      user0001("coach", "coach", "coach", null, now),
      env.DB.prepare("INSERT INTO users (id, username, password_hash, role, coach_id, created_at) VALUES (NULL, 'broken', 'h', 'athlete', 'coach', ?)").bind(now),
    ]);
    await expect(applyMigration(migration("0002"))).rejects.toThrow(/NOT NULL/i);
    // The batch is one transaction: nothing was half-applied.
    expect(await columnNames("users")).toEqual(["id", "username", "password_hash", "role", "coach_id", "created_at"]);
    expect(await userTables()).toContain("entries");
    expect((await userTables()).filter((name) => name.startsWith("__"))).toEqual([]);
    expect(await count("users")).toBe(2);
  });

  it("dropEverything + 0001 leaves no trace of 0002 (fixture sanity)", async () => {
    await rewindTo0001();
    expect(await columnNames("invites")).toContain("coach_id");
    expect((await foreignKeys("training_sessions")).length).toBe(0);
    await dropEverything();
    expect(await userTables()).toEqual([]);
    await applyMigration(migration("0001"));
    await applyMigration(migration("0002"));
  });
});
