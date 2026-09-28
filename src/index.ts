import { Hono } from "hono";
import type { Env } from "./db";
import auth from "./routes/auth";
import tracker from "./routes/tracker";
import coach from "./routes/coach";
import transfer from "./routes/transfer";

const app = new Hono<{ Bindings: Env }>();

app.route("/api/auth", auth);
app.route("/api/coach", coach);
app.route("/api", tracker);
app.route("/api", transfer);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

export default {
  fetch: app.fetch,
};
