/**
 * Shared helpers for Worker integration tests.
 *
 * Requests go through `SELF.fetch`, i.e. the real Worker built from
 * `wrangler.toml` (`src/index.ts`) with the test D1 and R2 bindings. Every
 * test file gets a freshly migrated database, and `setup.ts` calls
 * `resetStorage()` before each test, so a bootstrap done in one test does not
 * exist in the next. Do the bootstrap/login inside the test (or in a
 * `beforeEach`), not in `beforeAll`.
 *
 * Rate limits use Workers Rate Limiting bindings, which vitest.config.ts
 * replaces with the test-only `RATE_LIMIT_MODE = "allow"` mock, so no suite
 * hits 429 however many logins it issues. Tests that need the deny/error
 * paths set `env.RATE_LIMIT_MODE` themselves (see auth-rate-limit.test.ts).
 * There is no `rate_limits` table any more; `resetStorage` empties whatever
 * tables the migrations create, including `blob_cleanup` (0004), so a test
 * that queues R2 deletions never leaks records into the next test.
 */
import { SELF, env } from "cloudflare:test";

export const BASE_URL = "http://example.com";

/**
 * Empty every table (keeping the schema and the `d1_migrations` bookkeeping)
 * and delete every R2 object. Called automatically before each test by
 * `setup.ts`; call it yourself mid-test if you need a clean slate.
 */
export async function resetStorage(): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all<{ name: string }>();
  // Skip D1's internal `_cf_*` tables (not writable) and the migration log.
  const tables = results.map((row) => row.name).filter((name) => !name.startsWith("_cf_") && name !== "d1_migrations");
  if (tables.length > 0) {
    await env.DB.batch(tables.map((name) => env.DB.prepare(`DELETE FROM "${name}"`)));
  }
  let cursor: string | undefined;
  do {
    const listed = await env.ATTACHMENTS.list({ cursor });
    if (listed.objects.length > 0) await env.ATTACHMENTS.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/** A logged-in identity: carry `cookie` on every subsequent request. */
export interface Session {
  cookie: string;
  user: { id: string; username: string; role: "coach" | "athlete"; isOwner: boolean };
}

export interface RequestOptions {
  method?: string;
  /** JSON-serialised as the request body (sets Content-Type: application/json). */
  json?: unknown;
  /** Raw body (e.g. FormData for file uploads); ignored when `json` is set. */
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Defaults to BASE_URL; null removes Origin; a string overrides it. */
  origin?: string | null;
  /** Session cookie from `bootstrapCoach` / `login` / `acceptInvite`. */
  cookie?: string;
}

/** Issue a request against the Worker. Paths are relative, e.g. `/api/auth/status`. */
export async function api(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.origin === null) headers.delete("origin");
  else if (options.origin !== undefined || !headers.has("origin")) headers.set("origin", options.origin ?? BASE_URL);
  let body: BodyInit | undefined = options.body;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  if (options.cookie) headers.set("cookie", options.cookie);
  return SELF.fetch(new URL(path, BASE_URL).toString(), {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
  });
}

/** `api()` plus JSON parsing; returns the status and the parsed body. */
export async function apiJson<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<{ status: number; body: T; response: Response }> {
  const response = await api(path, options);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body: body as T, response };
}

/**
 * Extract the `dga_session` cookie pair from a response so it can be sent back
 * as a `Cookie` header. Throws if the response did not set one.
 */
export function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = /(?:^|,\s*)(dga_session=[^;]*)/.exec(header);
  if (!match) throw new Error(`No dga_session cookie in response (status ${response.status}): ${header}`);
  return match[1] as string;
}

export const DEFAULT_PASSWORD = "correct-horse-battery";

/**
 * Create the first (coach/owner) account via `POST /api/auth/bootstrap`.
 * Only works on an empty users table; a second call gets 409.
 */
export async function bootstrapCoach(
  username = "coach",
  password = DEFAULT_PASSWORD,
): Promise<Session> {
  const response = await api("/api/auth/bootstrap", { json: { username, password } });
  if (response.status !== 201) {
    throw new Error(`bootstrap failed: ${response.status} ${await response.text()}`);
  }
  const user = (await response.json()) as Session["user"];
  return { cookie: sessionCookie(response), user };
}

/** Log in with username/password via `POST /api/auth/login`. */
export async function login(username: string, password = DEFAULT_PASSWORD): Promise<Session> {
  const response = await api("/api/auth/login", { json: { username, password } });
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${await response.text()}`);
  }
  const user = (await response.json()) as Session["user"];
  return { cookie: sessionCookie(response), user };
}

/**
 * Create an invite as the given coach (`POST /api/auth/invites`) and return the
 * raw token. Pass `body` for fields later steps add (e.g. `{ role: "coach" }`).
 */
export async function createInvite(coach: Session, body: Record<string, unknown> = {}): Promise<string> {
  const response = await api("/api/auth/invites", { json: body, cookie: coach.cookie });
  if (response.status !== 201) {
    throw new Error(`create invite failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { token: string };
  return data.token;
}

/** Accept an invite token via `POST /api/auth/accept-invite`, creating and logging in the new user. */
export async function acceptInvite(
  token: string,
  username: string,
  password = DEFAULT_PASSWORD,
): Promise<Session> {
  const response = await api("/api/auth/accept-invite", { json: { token, username, password } });
  if (response.status !== 201) {
    throw new Error(`accept invite failed: ${response.status} ${await response.text()}`);
  }
  const user = (await response.json()) as Session["user"];
  return { cookie: sessionCookie(response), user };
}

/** Bootstrap a coach and invite + accept one athlete. Handy starting point for RBAC tests. */
export async function bootstrapTeam(): Promise<{ coach: Session; athlete: Session }> {
  const coach = await bootstrapCoach("coach");
  const token = await createInvite(coach);
  const athlete = await acceptInvite(token, "athlete");
  return { coach, athlete };
}

/** Browser-compatible raw File upload; never sets Content-Length. */
export function uploadFile(path: string, session: Session | undefined, metadata: Record<string, unknown> = {}, bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])): Promise<Response> {
  const { dayKey = "wed", kind = "document", label = "Plan notes", mimeType = "application/pdf" } = metadata;
  const query = new URLSearchParams({ dayKey: String(dayKey), kind: String(kind), label: String(label) });
  return api(path + "?" + query, {
    method: "POST", cookie: session?.cookie,
    headers: { "content-type": String(mimeType), "x-file-size": String(bytes.byteLength) },
    body: new File([bytes], "upload", { type: String(mimeType) }),
  });
}
