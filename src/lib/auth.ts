// WebCrypto-only auth primitives (no Node APIs): PBKDF2 password hashing,
// random token generation, SHA-256 token hashing, and session cookie helpers.

const encoder = new TextEncoder();
const SESSION_COOKIE_NAME = "dga_session";

// Password hashing ------------------------------------------------------------
//
// Stored format: `pbkdf2$<iterations>$<base64 16-byte salt>$<base64 32-byte hash>`
// (PBKDF2-HMAC-SHA256). New hashes use PBKDF2_ITERATIONS. Verification reads
// the count from the stored value and accepts any count in
// [PBKDF2_MIN_ITERATIONS, PBKDF2_MAX_ITERATIONS]; a supported count lower than
// PBKDF2_ITERATIONS is rehashed on successful login (services/auth.ts). Any
// other stored value (unsupported count such as the pre-0002 210k, a malformed
// encoding, wrong salt/hash length) fails verification without throwing and
// needs the operator reset runbook in aspec/devops/operations.md.

/** Iteration count for new hashes: the hosted Workers PBKDF2 maximum. */
export const PBKDF2_ITERATIONS = 100_000;
/** Highest count verification accepts. Hosted Workers reject anything above it. */
export const PBKDF2_MAX_ITERATIONS = 100_000;
/** Lowest count verification accepts; weaker stored hashes are treated as invalid. */
export const PBKDF2_MIN_ITERATIONS = 10_000;
export const PBKDF2_SALT_BYTES = 16;
export const PBKDF2_HASH_BYTES = 32;

export interface AuthUser {
  id: string;
  username: string;
  role: "coach" | "athlete";
  isOwner: boolean;
  createdAt: Date;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strict standard base64 (no whitespace, no URL alphabet); null when not decodable. */
function base64ToBytes(value: string): Uint8Array | null {
  if (!BASE64_PATTERN.test(value) || value.length % 4 !== 0) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations, hash: "SHA-256" },
    key,
    PBKDF2_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export interface ParsedPasswordHash {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

/**
 * Parses and validates a stored hash. Returns null (never throws) for an
 * unsupported iteration count, a non-integer count, a malformed encoding,
 * a salt other than 16 bytes or a hash other than 32 bytes.
 */
export function parsePasswordHash(stored: unknown): ParsedPasswordHash | null {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return null;
  const [, count, saltText, hashText] = parts as [string, string, string, string];
  if (!/^[1-9][0-9]{0,8}$/.test(count)) return null;
  const iterations = Number(count);
  if (!Number.isSafeInteger(iterations) || iterations < PBKDF2_MIN_ITERATIONS || iterations > PBKDF2_MAX_ITERATIONS) return null;
  const salt = base64ToBytes(saltText);
  const hash = base64ToBytes(hashText);
  if (!salt || !hash || salt.length !== PBKDF2_SALT_BYTES || hash.length !== PBKDF2_HASH_BYTES) return null;
  return { iterations, salt, hash };
}

/** True when the stored hash is valid but uses fewer iterations than new hashes do. */
export function needsRehash(parsed: ParsedPasswordHash): boolean {
  return parsed.iterations < PBKDF2_ITERATIONS;
}

/**
 * Verifies `password` against a stored hash. Invalid stored values fail
 * without throwing and without doing any comparison; callers that need
 * constant work for those cases burn a derivation themselves.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const actual = await deriveBits(password, parsed.salt, parsed.iterations);
  if (actual.length !== PBKDF2_HASH_BYTES || parsed.hash.length !== PBKDF2_HASH_BYTES) return false;
  let diff = 0;
  for (let i = 0; i < PBKDF2_HASH_BYTES; i++) diff |= (actual[i] as number) ^ (parsed.hash[i] as number);
  // Failed legacy checks do the same total PBKDF2 work as an unknown user.
  // This is dummy work, not verification with an unsupported stored count.
  if (diff !== 0 && parsed.iterations < PBKDF2_ITERATIONS) {
    await deriveBits(password, new Uint8Array(PBKDF2_SALT_BYTES), PBKDF2_ITERATIONS - parsed.iterations);
  }
  return diff === 0;
}

/** Opaque session/invite token: 32 random bytes rendered as hex. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Tokens are stored hashed (SHA-256 hex), never raw. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(): string {
  return crypto.randomUUID();
}

export function getSessionToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(index + 1).trim();
      if (!value) return null;
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

export function isSecureRequest(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  const maxAge = 30 * 86400; // 30 days, matches the session row TTL
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${
    secure ? "; Secure" : ""
  }; Max-Age=${maxAge}`;
}

export function clearSessionCookieHeader(secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=0`;
}
