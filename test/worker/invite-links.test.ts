import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { api, bootstrapCoach, DEFAULT_PASSWORD } from "./helpers";

it.each(["fragment", "legacy"])("an invite captured from a %s URL is accepted by token and starts an active session", async format => {
  const owner = await bootstrapCoach();
  const made = await api("/api/auth/invites", { cookie: owner.cookie, json: {} });
  expect(made.status).toBe(201);
  const invite = await made.json() as { invitePath: string; token: string };
  expect(invite.invitePath).toBe(`/invite#${invite.token}`);
  const url = new URL(format === "fragment" ? invite.invitePath : `/invite/${invite.token}`, "http://example.com");
  const token = format === "fragment" ? url.hash.slice(1) : url.pathname.split("/").at(-1);
  const accepted = await api("/api/auth/accept-invite", { json: { token, username: "new-athlete", password: DEFAULT_PASSWORD } });
  expect(accepted.status).toBe(201);
  expect(accepted.headers.get("set-cookie")).toContain("SameSite=Strict");
  const user = await accepted.json() as { id: string };
  expect(await env.DB.prepare("SELECT deactivated_at FROM users WHERE id=?").bind(user.id).first()).toEqual({ deactivated_at: null });
  expect((await api("/api/auth/accept-invite", { json: { token, username: "second", password: DEFAULT_PASSWORD } })).status).toBe(410);
});
