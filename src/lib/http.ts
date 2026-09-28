// HTTP plumbing shared by the route modules: request validation via
// @hono/zod-validator, error helpers and path-parameter parsing. Every
// validation failure is reported as `{ error: string }` with status 400.

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
export function zodErrorMessage(error: { issues: ReadonlyArray<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Invalid input";
}

/** `{ error }` response with an explicit status code. */
export function jsonError<S extends 400 | 401 | 403 | 404 | 409 | 410 | 429>(c: Context<AppBindings>, status: S, message: string) {
  return c.json({ error: message }, status);
}

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
 * `Content-Type: application/json`. A body that is not valid JSON yields
 * `{ error: "Invalid JSON body" }` (400), matching the pre-validator behaviour.
 */
export function validateJson<T extends z.ZodType>(schema: T): ValidatorMiddleware<"json", T> {
  const validate = zValidator("json", schema, errorHook) as unknown as ValidatorMiddleware<"json", T>;
  return async (c, next) => {
    // Hono caches the body text, so the validator's own read reuses this parse.
    try { await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    return validate(c, next);
  };
}

/** Validates the query string against `schema`; read it with `c.req.valid("query")`. */
export function validateQuery<T extends z.ZodType>(schema: T): ValidatorMiddleware<"query", T> {
  return zValidator("query", schema, errorHook) as unknown as ValidatorMiddleware<"query", T>;
}
