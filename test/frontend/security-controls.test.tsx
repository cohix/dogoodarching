import { StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../frontend/src/App";
import { api, ApiError, type Me } from "../../frontend/src/api";
import { SettingsTab } from "../../frontend/src/features/settings/SettingsTab";
import { TeamTab } from "../../frontend/src/features/team/TeamTab";
import { resetAccount } from "../../frontend/src/lib/account";

const athlete: Me = { id: "athlete", username: "archer", role: "athlete", isOwner: false };
const owner: Me = { id: "owner", username: "owner", role: "coach", isOwner: true };
const coach: Me = { id: "coach", username: "coach-two", role: "coach", isOwner: false };
const clients: QueryClient[] = [];
function show(element: ReactNode, me = athlete) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  client.setQueryData(["me"], me);
  client.setQueryData(["tracker"], { notes: "private cached notes" });
  render(<StrictMode><QueryClientProvider client={client}>{element}</QueryClientProvider></StrictMode>);
  return client;
}
function fill(label: string, value: string) { fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } }); }
afterEach(() => { cleanup(); clients.forEach(c => c.clear()); clients.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

it.each(["/invite#opaque-token", "/invite/opaque-token", "/invite/opaque-token/"])("captures and immediately scrubs %s, including StrictMode", async path => {
  window.history.replaceState(null, "", path);
  const accept = vi.spyOn(api, "acceptInvite").mockRejectedValue(new ApiError(410, "Expired"));
  show(<App />);
  expect(window.location.pathname + window.location.hash).toBe("/invite");
  fill("Username", "new-athlete"); fill("Password", "password-value");
  fireEvent.click(screen.getByRole("button", { name: "Join and log in" }));
  await screen.findByRole("alert");
  expect(accept).toHaveBeenCalledWith({ token: "opaque-token", username: "new-athlete", password: "password-value" });
});

it("rejects mismatching passwords, displays server errors, then retains the current account on success", async () => {
  const change = vi.spyOn(api, "changePassword").mockRejectedValueOnce(new ApiError(400, "Incorrect password")).mockResolvedValue({ ok: true });
  const client = show(<SettingsTab me={athlete} />);
  fill("Current password", "old-password"); fill("New password", "new-password"); fill("Confirm new password", "different");
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(screen.getByRole("alert").textContent).toContain("do not match");
  expect(change).not.toHaveBeenCalled();
  fill("Confirm new password", "new-password");
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Incorrect password");
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  await screen.findByText("Password changed. Your other sessions have been signed out.");
  expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
  expect(client.getQueryData(["me"])).toEqual(athlete);
  expect(client.getQueryData(["tracker"])).toEqual({ notes: "private cached notes" });
  expect(client.getQueryState(["me"])?.isInvalidated).toBe(true);
});

it.each(["logout", "delete"])("%s clears all account queries/mutations on success", async action => {
  vi.spyOn(api, "logoutAll").mockResolvedValue({ ok: true });
  vi.spyOn(api, "deleteAccount").mockResolvedValue({ ok: true });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const client = show(<SettingsTab me={athlete} />);
  client.setQueryData(["invites", "old-owner", true], ["secret-token"]);
  if (action === "delete") fill("Password to confirm deletion", "old-password");
  fireEvent.click(screen.getByRole("button", { name: action === "delete" ? "Delete account" : "Sign out everywhere" }));
  await waitFor(() => expect(client.getQueryData(["me"])).toBeNull());
  // This isolated Settings mount remains rendered; its disabled coach query
  // may be recreated empty. No previous account data survives the reset.
  expect(client.getQueryCache().getAll().filter(q => q.state.data !== undefined).map(q => q.queryKey)).toEqual([["me"]]);
  expect(client.getMutationCache().getAll()).toEqual([]);
  if (action === "delete") expect(api.deleteAccount).toHaveBeenCalledWith({ password: "old-password" });
});

it("owner gets a transfer picker excluding self; transfer discards owner caches and updates /me", async () => {
  vi.spyOn(api, "listCoaches").mockResolvedValue({ coaches: [owner, coach].map(c => ({ ...c, createdAt: "2026-09-28T12:00:00Z" })) });
  vi.spyOn(api, "transferOwnership").mockResolvedValue({ ok: true, previousOwnerId: owner.id, newOwnerId: coach.id });
  const client = show(<SettingsTab me={owner} />, owner);
  client.setQueryData(["invites", owner.id, true], ["old-owner-token"]);
  const picker = await screen.findByLabelText("New owner");
  expect(screen.queryByRole("button", { name: "Delete account" })).toBeNull();
  expect(Array.from((picker as HTMLSelectElement).options).map(o => o.value)).toEqual(["", coach.id]);
  fill("New owner", coach.id); fill("Password to confirm transfer", "owner-password");
  fireEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
  await waitFor(() => expect(client.getQueryData<Me>(["me"])?.isOwner).toBe(false));
  expect(api.transferOwnership).toHaveBeenCalledWith({ coachId: coach.id, password: "owner-password" });
  expect(client.getQueryData(["invites", owner.id, true])).toBeUndefined();
});

it("deactivate/toggle/reactivate uses distinct roster queries and invalidates the athlete overview", async () => {
  let inactive = false;
  const row = () => ({ id: athlete.id, username: athlete.username, createdAt: "2026-09-28T12:00:00Z", deactivatedAt: inactive ? "2026-09-28T13:00:00Z" : null });
  const list = vi.spyOn(api, "listAthletes").mockImplementation(async options => ({ athletes: !inactive || options?.includeDeactivated ? [row()] : [] }));
  vi.spyOn(api, "listInvites").mockResolvedValue([]);
  vi.spyOn(api, "deactivateAthlete").mockImplementation(async () => { inactive = true; return row(); });
  vi.spyOn(api, "reactivateAthlete").mockImplementation(async () => { inactive = false; return row(); });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const client = show(<TeamTab me={coach} />, coach);
  client.setQueryData(["coach-overview", athlete.id, "today"], { old: true });
  fireEvent.click(await screen.findByRole("button", { name: "Deactivate archer" }));
  await screen.findByText(/No active athletes/);
  expect(client.getQueryState(["coach-overview", athlete.id, "today"])?.isInvalidated).toBe(true);
  fireEvent.click(screen.getByLabelText("Show deactivated"));
  fireEvent.click(await screen.findByRole("button", { name: "Reactivate archer" }));
  await screen.findByRole("button", { name: "Deactivate archer" });
  expect(list).toHaveBeenCalledWith({ includeDeactivated: true });
  expect(api.deactivateAthlete).toHaveBeenCalledWith(athlete.id);
  expect(api.reactivateAthlete).toHaveBeenCalledWith(athlete.id);
});

it("late account reads cannot restore data after cache reset and another login", async () => {
  const client = show(<div />);
  let resolve!: (data: unknown) => void;
  const pending = client.fetchQuery({ queryKey: ["private-slow"], queryFn: () => new Promise(r => { resolve = r; }) }).catch(() => {});
  resetAccount(client, coach);
  resolve({ private: "previous user's notes" });
  await pending;
  expect(client.getQueryData(["private-slow"])).toBeUndefined();
  expect(client.getQueryData(["me"])).toEqual(coach);
});

it.each([false, true])("raw browser upload (coach=%s) sends File, MIME and size without JSON or Content-Length", async asCoach => {
  const fetch = vi.fn().mockResolvedValue(new Response('{"id":1}', { status: 200 })); vi.stubGlobal("fetch", fetch);
  const file = new File(["raw-file-bytes"], "plan & notes.pdf", { type: "application/pdf" });
  const input = { dayKey: "mon" as const, kind: "document" as const, label: file.name, file };
  if (asCoach) await api.coachAddPlannedSessionFile(athlete.id, input); else await api.addPlannedSessionFile(input);
  const [url, init] = fetch.mock.calls[0];
  expect(new URL(url, window.location.origin).searchParams.get("label")).toBe(file.name);
  expect(init.body).toBe(file);
  expect(init.credentials).toBe("include");
  expect(new Headers(init.headers).get("content-type")).toBe("application/pdf");
  expect(new Headers(init.headers).get("x-file-size")).toBe(String(file.size));
  expect(new Headers(init.headers).has("content-length")).toBe(false);
});

it.each([413, 415, 429, 500])("raw upload exposes the server's %s message", async status => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":"Upload rejected"}', { status })));
  await expect(api.addPlannedSessionFile({ dayKey: "mon", kind: "photo", label: "Photo", file: new File(["a"], "a.png", { type: "image/png" }) })).rejects.toMatchObject({ status, message: "Upload rejected" });
});
