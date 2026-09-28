import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { datedProgramState } from "../../src/lib/dates";

it("migrates populated 0001 data, preserves score ends and anchors, and removes orphans", async () => {
  // This test file owns its isolated D1. Rewind the empty harness DB to 0001,
  // then apply the actual migration statements as one D1 batch like Wrangler.
  const { results: tables } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'").all<{ name: string }>();
  await env.DB.batch(tables.sort((a, b) => Number(a.name === "users") - Number(b.name === "users")).map(({ name }) => env.DB.prepare(`DROP TABLE "${name}"`)));
  await env.DB.batch(env.TEST_MIGRATIONS[0].queries.map((query) => env.DB.prepare(query)));
  const now = Date.now();
  const previousAnchor = Date.parse("2026-09-01T12:00:00Z");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('owner', 'coach', 'hash', 'coach', NULL, ?) ").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('athlete', 'athlete', 'hash', 'athlete', 'owner', ?) ").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('missing-creator', 'missing', 'hash', 'athlete', 'gone', ?) ").bind(now),
    env.DB.prepare("INSERT INTO invites VALUES ('invite', 'token', 'owner', ?, NULL, ?) ").bind(now + 86400000, now),
    env.DB.prepare("INSERT INTO invites VALUES ('orphan-invite', 'token2', 'gone', ?, NULL, ?) ").bind(now + 86400000, now),
    env.DB.prepare("INSERT INTO program_state VALUES ('athlete', 30, 3, 4, ?) ").bind(previousAnchor),
    env.DB.prepare("INSERT INTO program_state VALUES ('gone', 24, 2, 6, ?) ").bind(now),
    env.DB.prepare("INSERT INTO practice_scores VALUES (1, 'athlete', '2026-09-28', 30, ?) ").bind(now),
    env.DB.prepare("INSERT INTO practice_score_ends VALUES (1, 'athlete', 1, 1, 10, 10, 10, 30)"),
    env.DB.prepare("INSERT INTO practice_score_ends VALUES (2, 'gone', 1, 2, 10, 10, 10, 30)"),
    env.DB.prepare("INSERT INTO sessions VALUES ('session', 'session-token', 'athlete', ?, ?) ").bind(now + 86400000, now),
    env.DB.prepare("INSERT INTO sessions VALUES ('orphan-session', 'orphan-token', 'gone', ?, ?) ").bind(now + 86400000, now),
    env.DB.prepare("INSERT INTO training_sessions (user_id, session_date, session_type, created_at) VALUES ('gone', '2026-09-28', 'Range', ?) ").bind(now),
  ]);
  await env.DB.batch(env.TEST_MIGRATIONS[1].queries.map((query) => env.DB.prepare(query)));
  expect(await env.DB.prepare("SELECT is_owner FROM users WHERE id = 'owner'").first("is_owner")).toBe(1);
  expect(await env.DB.prepare("SELECT invited_by FROM users WHERE id = 'athlete'").first("invited_by")).toBe("owner");
  expect(await env.DB.prepare("SELECT invited_by FROM users WHERE id = 'missing-creator'").first("invited_by")).toBeNull();
  expect(await env.DB.prepare("SELECT created_by FROM invites WHERE id = 'invite'").first("created_by")).toBe("owner");
  expect(await env.DB.prepare("SELECT created_by FROM invites WHERE id = 'orphan-invite'").first("created_by")).toBeNull();
  expect(await env.DB.prepare("SELECT role FROM invites WHERE id = 'invite'").first("role")).toBe("athlete");
  expect(await env.DB.prepare("SELECT count(*) FROM practice_score_ends").first("count(*)")).toBe(1);
  expect(await env.DB.prepare("SELECT count(*) FROM sessions").first("count(*)")).toBe(1);
  expect(await env.DB.prepare("SELECT count(*) FROM training_sessions").first("count(*)")).toBe(0);
  expect(await env.DB.prepare("SELECT updated_at FROM program_state WHERE user_id = 'athlete'").first("updated_at")).toBe(previousAnchor);
  const backfilled = await env.DB.prepare("SELECT current_poundage, current_cycle, current_week, updated_at FROM program_state WHERE user_id = 'owner'")
    .first<{ current_poundage: number; current_cycle: number; current_week: number; updated_at: number }>();
  expect(backfilled?.current_poundage).toBe(24);
  const anchor = new Date(backfilled!.updated_at);
  expect(Math.abs(anchor.getTime() - now)).toBeLessThan(5000);
  // Compare to the former per-request fallback using the real date helper.
  for (const offset of [-1, 0, 1]) {
    const today = new Date(now + offset * 86400000).toISOString().slice(0, 10);
    expect(datedProgramState({ currentCycle: backfilled!.current_cycle, currentWeek: backfilled!.current_week, updatedAt: anchor }, today))
      .toEqual(datedProgramState({ currentCycle: 2, currentWeek: 6, updatedAt: new Date(now) }, today));
  }
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'entries'").first()).toBeNull();
  // The expression index must remain an expression, not a quoted identifier.
  await expect(env.DB.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('duplicate', 'COACH', 'hash', 'athlete', ?)").bind(now).run()).rejects.toThrow(/UNIQUE/);
  await env.DB.prepare("DELETE FROM users WHERE id = 'owner'").run();
  expect(await env.DB.prepare("SELECT created_by FROM invites WHERE id = 'invite'").first("created_by")).toBeNull();
  expect(await env.DB.prepare("SELECT invited_by FROM users WHERE id = 'athlete'").first("invited_by")).toBeNull();
  await env.DB.prepare("DELETE FROM users WHERE id = 'athlete'").run();
  expect(await env.DB.prepare("SELECT count(*) FROM practice_score_ends").first("count(*)")).toBe(0);
  expect(await env.DB.prepare("SELECT count(*) FROM sessions").first("count(*)")).toBe(0);
});
