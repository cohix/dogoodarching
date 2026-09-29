import { env } from "cloudflare:test";

/** A deterministic rendezvous; no sleeps, scheduling assumptions or fake D1 results. */
export function rendezvous() {
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}

/** Interpose only at execution boundaries; every query still runs on local D1.
 * Unwrap statements before batch() so D1 receives its own prepared objects.
 */
export function interceptD1(db: D1Database, hook: (sql: string, phase: "before" | "after") => Promise<void>): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const queries = new WeakMap<D1PreparedStatement, string>();
  function statement(real: D1PreparedStatement, sql: string): D1PreparedStatement {
    const wrapped = new Proxy(real, { get(target, key) {
      if (key === "bind") return (...args: unknown[]) => statement(target.bind(...args), sql);
      const value = Reflect.get(target, key, target);
      if (["raw", "all", "first", "run"].includes(String(key))) return async (...args: unknown[]) => {
        await hook(sql, "before");
        const result = await value.apply(target, args);
        await hook(sql, "after");
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(wrapped, real);
    queries.set(wrapped, sql);
    return wrapped;
  }
  return new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      const sql = statements.map(s => queries.get(s) ?? "").join(";\n");
      await hook(sql, "before");
      const result = await target.batch(statements.map(s => originals.get(s) ?? s));
      await hook(sql, "after");
      return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

export const ACCOUNT_TABLES = [
  "program_state", "training_sessions", "cycle_week_plans", "planned_session_overrides",
  "planned_session_attachments", "milestone_checks", "maintenance_checks", "maintenance_items",
  "inspiration_entries", "weekly_notes", "practice_scores", "practice_score_ends", "bow_setups", "sessions",
] as const;

/** Populate every account-owned table; caller creates identity/session using HTTP. */
export async function seedAccountData(userId: string, id: number) {
  const now = Date.parse("2026-09-21T12:00:00Z");
  const key = `security-account/${userId}/file.pdf`;
  await env.ATTACHMENTS.put(key, "private bytes");
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO program_state VALUES (?, NULL, 2, 3, ?)").bind(userId, now),
    env.DB.prepare("INSERT INTO training_sessions (id,user_id,session_date,session_type,arrows,notes,created_at) VALUES (?,?,'2026-09-21','Range',60,'private history',?)").bind(id,userId,now),
    env.DB.prepare("INSERT INTO cycle_week_plans VALUES (?,1,'Focus','','',?)").bind(userId,now),
    env.DB.prepare("INSERT INTO planned_session_overrides VALUES (?,'mon','Range','Detail','Rx',?)").bind(userId,now),
    env.DB.prepare("INSERT INTO planned_session_attachments (id,user_id,day_key,kind,label,blob_key,mime_type,created_at,size_bytes) VALUES (?,?,'mon','document','Private',?,'application/pdf',?,13)").bind(id,userId,key,now),
    env.DB.prepare("INSERT INTO milestone_checks VALUES (?,'m1',1,?)").bind(userId,now),
    env.DB.prepare("INSERT INTO maintenance_checks VALUES (?,'legacy-key',1,?)").bind(userId,now),
    env.DB.prepare("INSERT INTO maintenance_items (id,user_id,section,label,created_at,updated_at) VALUES (?,?,'Weekly','Wax',?,?)").bind(id,userId,now,now),
    env.DB.prepare("INSERT INTO inspiration_entries (id,user_id,thought_text,video_title,video_url,recipe_name,recipe_summary,recipe_ingredients,updated_at) VALUES (?,?,'thought','v','https://example.com','r','s','i',?)").bind(id,userId,now),
    env.DB.prepare("INSERT INTO weekly_notes (id,user_id,week_start,notes,created_at,updated_at) VALUES (?,?,'2026-09-21','private notes',?,?)").bind(id,userId,now,now),
    env.DB.prepare("INSERT INTO practice_scores (id,user_id,score_date,total,created_at) VALUES (?,?,'2026-09-21',30,?)").bind(id,userId,now),
    env.DB.prepare("INSERT INTO practice_score_ends (id,user_id,score_id,end_number,arrow_1,arrow_2,arrow_3,end_total) VALUES (?,?,?,1,10,10,10,30)").bind(id,userId,id),
    env.DB.prepare("INSERT INTO bow_setups (id,user_id,poundage,name,updated_at) VALUES (?,?,30,'Setup',?)").bind(id,userId,now),
  ]);
  return key;
}

export async function accountSnapshot(userId: string) {
  const snapshots: Record<string, unknown[]> = {};
  for (const table of ACCOUNT_TABLES) {
    snapshots[table] = (await env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY rowid`).bind(userId).all()).results;
  }
  return snapshots;
}
