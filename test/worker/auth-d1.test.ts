import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { acceptInvite, api, apiJson, bootstrapCoach, createInvite, DEFAULT_PASSWORD } from "./helpers";

const credentials = (username: string) => ({ username, password: DEFAULT_PASSWORD });

describe("D1 account creation", () => {
  it("bootstraps an owner once and returns 409 on the next attempt", async () => {
    const owner = await bootstrapCoach();
    expect(owner.user.isOwner).toBe(true);
    expect((await api("/api/auth/bootstrap", { json: credentials("second") })).status).toBe(409);
    const me = await apiJson("/api/auth/me", { cookie: owner.cookie });
    expect(me.body).toEqual(owner.user);
  });

  it("accepts once, rolls back a taken username claim, and rejects reuse", async () => {
    const owner = await bootstrapCoach();
    const token = await createInvite(owner);
    expect((await api("/api/auth/accept-invite", { json: { token, ...credentials("COACH") } })).status).toBe(409);
    expect(await env.DB.prepare("SELECT used_at FROM invites").first("used_at")).toBeNull();
    const athlete = await acceptInvite(token, "athlete");
    expect(athlete.user).toMatchObject({ role: "athlete", isOwner: false });
    expect((await api("/api/auth/accept-invite", { json: { token, ...credentials("another") } })).status).toBe(410);
    expect(await env.DB.prepare("SELECT invited_by FROM users WHERE id = ?").bind(athlete.user.id).first("invited_by")).toBe(owner.user.id);
  });

  it("allows only one concurrent bootstrap and one concurrent invite acceptance", async () => {
    const bootstraps = await Promise.all(["first", "second"].map((username) => api("/api/auth/bootstrap", { json: credentials(username) })));
    expect(bootstraps.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = bootstraps.find((r) => r.status === 201)!;
    const cookie = winner.headers.get("set-cookie")!.split(";")[0];
    const invitation = await apiJson<{ token: string }>("/api/auth/invites", { cookie, json: {} });
    const accepts = await Promise.all(["one", "two"].map((username) => api("/api/auth/accept-invite", { json: { token: invitation.body.token, ...credentials(username) } })));
    expect(accepts.map((r) => r.status).sort()).toEqual([201, 410]);
    expect(await env.DB.prepare("SELECT count(*) FROM users").first("count(*)")).toBe(2);
  });

  it("creates coaches with shared athletes and enforces owner-only coach invites", async () => {
    const owner = await bootstrapCoach();
    const coach = await acceptInvite(await createInvite(owner, { role: "coach" }), "coach2");
    const athlete = await acceptInvite(await createInvite(owner), "athlete");
    expect(coach.user).toMatchObject({ role: "coach", isOwner: false });
    expect((await api("/api/auth/invites", { cookie: coach.cookie, json: { role: "coach" } })).status).toBe(403);
    const roster = await apiJson<{ athletes: { id: string }[] }>("/api/coach/athletes", { cookie: coach.cookie });
    expect(roster.body.athletes.map((a) => a.id)).toEqual([athlete.user.id]);
    expect((await api("/api/coach/coaches", { cookie: owner.cookie })).status).toBe(200);
    expect((await api("/api/coach/coaches", { cookie: coach.cookie })).status).toBe(403);
  });
});
