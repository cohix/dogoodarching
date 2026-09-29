// HTTP plumbing shared by the route modules: request validation via
// @hono/zod-validator, error helpers and path-parameter parsing. Every
// validation failure is reported as `{ error: string }`.

import type { Context, Env, MiddlewareHandler } from "hono";
import { zValidator, type Hook } from "@hono/zod-validator";
import type { z } from "zod";
import type { AppBindings } from "./rbac";

const downloadExtensions: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "application/octet-stream": "bin",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/** ASCII fallback plus RFC 5987 UTF-8 filename, with a MIME-derived extension. */
export function buildContentDisposition(label: string, mimeType: string): string {
  const extension = downloadExtensions[mimeType.split(";")[0].trim().toLowerCase()] ?? "bin";
  const clean = Array.from(label, (character) => {
    const code = character.codePointAt(0)!;
    // Remove controls and replace unpaired surrogates before URI encoding.
    return code < 32 || code === 127 ? "" : code >= 0xD800 && code <= 0xDFFF ? "_" : character;
  }).join("").replace(/[\\/]/g, "-").trim();
  const stem = clean.replace(/\.[a-z0-9]{1,10}$/i, "").replace(/^\.+|\.+$/g, "") || "file";
  const filename = `${stem}.${extension}`;
  const fallback = filename.normalize("NFKD").replace(/[^\x20-\x7E]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Parses a positive integer path parameter; null for anything else. */
export function parsePositiveInt(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** First issue's message, which is what the API reports to the client. */
export function zodErrorMessage(error: { issues: ReadonlyArray<{ message: string; path?: readonly PropertyKey[] }> }, includePath = false): string {
  const issue = error.issues[0];
  return issue ? `${includePath && issue.path?.length ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message}` : "Invalid input";
}

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 429 | 500 | 503;

/** Only deliberately public messages belong here; never wrap an upstream error. */
export class UserFacingError extends Error {
  readonly status: ErrorStatus;
  readonly publicMessage: string;

  constructor(status: ErrorStatus, publicMessage: string) {
    super(publicMessage);
    this.name = "UserFacingError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

/** `{ error }` response with an explicit status code. */
export function jsonError<S extends ErrorStatus>(c: Context, status: S, message: string) {
  return c.json({ error: message }, status);
}

/** All unsafe requests need browser-controlled proof, independent of body type. */
export const sameOriginGuard: MiddlewareHandler = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    // Use Headers.get: Hono's header helper collapses an empty value to absent.
    const origin = c.req.raw.headers.get("Origin");
    const expected = new URL(c.req.url).origin;
    // A present Origin always wins over Fetch Metadata, including "null".
    const allowed = origin !== null
      ? origin === expected
      : c.req.header("Sec-Fetch-Site") === "same-origin";
    if (!allowed) return jsonError(c, 403, "Same-origin request required");
  }
  await next();
};

type Validated<Target extends "json" | "query", T extends z.ZodType> = {
  in: { [K in Target]: z.input<T> };
  out: { [K in Target]: z.output<T> };
};

type ValidatorMiddleware<Target extends "json" | "query", T extends z.ZodType> = MiddlewareHandler<
  AppBindings,
  string,
  Validated<Target, T>
>;

// Replaces zod-validator's default `{ success, error }` body so failures keep
// the API's `{ error: string }` shape and 400 status.
const errorHook: Hook<unknown, Env, string> = (result, c) => {
  if (!result.success) return c.json({ error: zodErrorMessage(result.error) }, 400);
};

/**
 * Validates a JSON request body against `schema`; the handler reads the parsed
 * value with `c.req.valid("json")`. Requests must carry
 * `Content-Type: application/json` (optional charset); missing/other types
 * yield 415 before the body is read. A body that is not valid JSON yields
 * `{ error: "Invalid JSON body" }` (400), matching the pre-validator behaviour.
 */
export function validateJson<T extends z.ZodType>(schema: T, maxBytes?: number): ValidatorMiddleware<"json", T> {
  const validate = zValidator("json", schema, errorHook) as unknown as ValidatorMiddleware<"json", T>;
  return async (c, next) => {
    // Check before touching the body. Accept JSON with an optional charset,
    // but not form bodies, JSON suffix types, or arbitrary media parameters.
    const contentType = c.req.header("Content-Type") ?? "";
    if (!/^application\/json(?:;\s*charset=(?:[\w-]+|"[\w-]+"))?$/i.test(contentType)) {
      return jsonError(c, 415, "Content-Type must be application/json");
    }
    if (maxBytes !== undefined) {
      const length = c.req.header("Content-Length");
      if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
        return jsonError(c, 413, `JSON body exceeds ${maxBytes} bytes`);
      }
      const reader = c.req.raw.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        if (reader) for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            return jsonError(c, 413, `JSON body exceeds ${maxBytes} bytes`);
          }
          chunks.push(value);
        }
      } catch { return jsonError(c, 400, "Invalid JSON body"); }
      finally { reader?.releaseLock(); }
      const decoder = new TextDecoder();
      const text = chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return jsonError(c, 400, "Invalid JSON body"); }
      const result = await schema.safeParseAsync(parsed);
      if (!result.success) return jsonError(c, 400, zodErrorMessage(result.error, true));
      c.req.addValidatedData("json", result.data as z.output<T> & {});
      return next();
    }
    // Hono caches the body text, so the validator's own read reuses this parse.
    try { await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    return validate(c, next);
  };
}

/** Validates the query string against `schema`; read it with `c.req.valid("query")`. */
export function validateQuery<T extends z.ZodType>(schema: T): ValidatorMiddleware<"query", T> {
  return zValidator("query", schema, errorHook) as unknown as ValidatorMiddleware<"query", T>;
}
