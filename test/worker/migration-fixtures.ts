/**
 * Helpers for replaying the SQL migrations by hand inside a test file's
 * isolated D1: rewind to an empty database, apply 0001, seed old-shape rows,
 * apply 0002. `env.TEST_MIGRATIONS` is the same list `setup.ts` applies in
 * `beforeAll`, read from `migrations/*.sql` by vitest.config.ts.
 */
import { env } from "cloudflare:test";

export interface Migration {
  name: string;
  queries: string[];
}

export function migration(prefix: "0001" | "0002" | "0003" | "0004" | "0005" | "0006"): Migration {
  const found = env.TEST_MIGRATIONS.find((m) => m.name.startsWith(prefix));
  if (!found) throw new Error(`migration ${prefix}_*.sql not found in TEST_MIGRATIONS (${env.TEST_MIGRATIONS.map((m) => m.name).join(", ")})`);
  return found;
}

/** All user tables (not sqlite_*, not D1's _cf_*, not the migration log). */
export async function userTables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

/** Drop every user table so the next call can replay migrations from nothing. */
export async function dropEverything(): Promise<void> {
  const tables = await userTables();
  // Children before parents so FK actions never fire on a populated parent.
  const order = (name: string) => (name === "users" ? 2 : name === "practice_scores" ? 1 : 0);
  const sorted = [...tables].sort((a, b) => order(a) - order(b));
  if (sorted.length > 0) await env.DB.batch(sorted.map((name) => env.DB.prepare(`DROP TABLE "${name}"`)));
}

/** Apply one migration's statements as a single D1 batch, like Wrangler does. */
export async function applyMigration(m: Migration): Promise<void> {
  await env.DB.batch(m.queries.map((query) => env.DB.prepare(query)));
}

/** Empty database at schema 0001. */
export async function rewindTo0001(): Promise<void> {
  await dropEverything();
  await applyMigration(migration("0001"));
}

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export async function columns(table: string): Promise<ColumnInfo[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info("${table}")`).all<ColumnInfo>();
  return results;
}

export async function columnNames(table: string): Promise<string[]> {
  return (await columns(table)).map((c) => c.name);
}

export interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

export async function foreignKeys(table: string): Promise<ForeignKeyInfo[]> {
  const { results } = await env.DB.prepare(`PRAGMA foreign_key_list("${table}")`).all<ForeignKeyInfo>();
  return results;
}

export async function indexNames(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`PRAGMA index_list("${table}")`).all<{ name: string }>();
  return results.map((row) => row.name).sort();
}

export async function fkCheck(): Promise<unknown[]> {
  return (await env.DB.prepare("PRAGMA foreign_key_check").all()).results;
}

export async function scalar<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
  const row = await env.DB.prepare(sql).bind(...binds).first<Record<string, T>>();
  if (!row) return null;
  const [value] = Object.values(row);
  return value ?? null;
}

export async function count(table: string, where = "1 = 1", ...binds: unknown[]): Promise<number> {
  return (await scalar<number>(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`, ...binds)) ?? 0;
}

/** Seed helper: an 0001-shape user row (`coach_id` column, no is_owner). */
export function user0001(id: string, username: string, role: "coach" | "athlete", coachId: string | null, createdAt: number, passwordHash = "hash") {
  return env.DB.prepare("INSERT INTO users (id, username, password_hash, role, coach_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, username, passwordHash, role, coachId, createdAt);
}

/**
 * Applies every migration after 0002 (0003 drop rate_limits, 0004 lifecycle).
 * The Worker's queries expect the full schema (e.g. `users.deactivated_at`),
 * so tests that call the API after replaying 0002 by hand run this first.
 */
export async function applyLaterMigrations(): Promise<void> {
  await applyMigration(migration("0003"));
  await applyMigration(migration("0004"));
  await applyMigration(migration("0005"));
  await applyMigration(migration("0006"));
}
