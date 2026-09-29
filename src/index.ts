import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { jsonError, sameOriginGuard, UserFacingError } from "./lib/http";
import type { Env } from "./db";
import auth from "./routes/auth";
import tracker from "./routes/tracker";
import coach from "./routes/coach";
import transfer from "./routes/transfer";
import { runScheduledCleanup } from "./services/cleanup";

const app = new Hono<{ Bindings: Env }>();

// Outermost middleware decorates final responses, including onError and raw
// Response downloads. Keep the policy aligned with frontend/public/_headers.
app.use("/api/*", secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    imgSrc: ["'self'", "blob:", "data:"],
    frameSrc: ["https://www.youtube.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    frameAncestors: ["'none'"],
  },
  referrerPolicy: "no-referrer",
  strictTransportSecurity: "max-age=31536000; includeSubDomains",
  xContentTypeOptions: "nosniff",
  xFrameOptions: "DENY",
  permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] },
}));
app.use("/api/*", sameOriginGuard);

app.route("/api/auth", auth);
app.route("/api/coach", coach);
app.route("/api", tracker);
app.route("/api", transfer);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  if (err instanceof UserFacingError) return jsonError(c, err.status, err.publicMessage);
  // Exception messages, stacks and URLs may contain bodies, passwords or invite
  // tokens. Log only a fixed event; do not serialize arbitrary thrown values.
  console.error("Unhandled API error");
  return jsonError(c, 500, "Internal server error");
});

const worker = {
  fetch: app.fetch,
  // Cron Trigger (`[triggers]` in wrangler.toml, UTC): expired sessions, stale
  // invites and pending R2 deletions. Bounded per run and idempotent, so an
  // overlapping or missed run is harmless. The job body lives in
  // services/cleanup.ts so tests can call it directly.
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduledCleanup(env, new Date(controller.scheduledTime)).then((report) => {
      console.log(`scheduled cleanup: ${JSON.stringify(report)}`);
    }, () => {
      // Only a fixed event: the report/exception could name blob keys or D1 errors.
      console.error("scheduled cleanup failed");
    }));
  },
} satisfies ExportedHandler<Env>;

export default worker;
