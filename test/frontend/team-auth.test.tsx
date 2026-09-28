import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError, type Me } from "../../frontend/src/api";
import { TeamTab } from "../../frontend/src/features/team/TeamTab";
import { AuthScreen, InviteAcceptScreen } from "../../frontend/src/features/auth/AuthScreen";

const coach: Me = { id: "coach", username: "coach", role: "coach", isOwner: false };
function show(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
beforeEach(() => {
  vi.spyOn(api, "listAthletes").mockResolvedValue({ athletes: [{ id: "athlete", username: "shared-athlete", createdAt: "2026-09-28T12:00:00Z" }] });
  vi.spyOn(api, "listCoaches").mockResolvedValue({ coaches: [{ ...coach, createdAt: "2026-09-28T12:00:00Z" }] });
  vi.spyOn(api, "listInvites").mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([false, true])("shows owner-only coach controls (owner=%s), and sends the chosen invite role", async (isOwner) => {
  const create = vi.spyOn(api, "createInvite").mockResolvedValue({ token: "opaque", invitePath: "/invite/opaque", expiresInHours: 24 });
  show(<TeamTab me={{ ...coach, isOwner }} />);
  await screen.findByText("shared-athlete");
  expect(Boolean(screen.queryByRole("button", { name: "+ Invite coach" }))).toBe(isOwner);
  expect(Boolean(screen.queryByRole("heading", { name: "Coaches" }))).toBe(isOwner);
  if (!isOwner) expect(api.listCoaches).not.toHaveBeenCalled();
  const role = isOwner ? "coach" : "athlete";
  fireEvent.click(screen.getByRole("button", { name: `+ Invite ${role}` }));
  await screen.findByText(`${window.location.origin}/invite/opaque`);
  expect(create).toHaveBeenCalledWith({ role });
});

it.each([200, 404])("refreshes the invite list after revocation returns %s", async (status) => {
  const now = Date.now();
  vi.mocked(api.listInvites).mockResolvedValueOnce([{ id: "invite", role: "athlete", createdBy: coach.id, createdAt: now, expiresAt: now + 60_000, usedAt: null }]).mockResolvedValue([]);
  const revoke = vi.spyOn(api, "revokeInvite");
  if (status === 200) revoke.mockResolvedValue({ ok: true });
  else revoke.mockRejectedValue(new ApiError(404, "Not found"));
  show(<TeamTab me={coach} />);
  fireEvent.click(await screen.findByRole("button", { name: /Revoke athlete invite/ }));
  await screen.findByText("No pending invites.");
  expect(revoke).toHaveBeenCalledWith({ id: "invite" });
  expect(screen.queryByRole("button", { name: /Revoke athlete invite/ })).toBeNull();
});

it("shows a creation error without inventing an invite link", async () => {
  vi.spyOn(api, "createInvite").mockRejectedValue(new ApiError(403, "Forbidden"));
  show(<TeamTab me={{ ...coach, isOwner: true }} />);
  fireEvent.click(screen.getByRole("button", { name: "+ Invite coach" }));
  await screen.findByText(/Only the owner can invite coaches/);
  expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
});

it("uses role-neutral invitation copy and accepts a coach invite through the real form", async () => {
  const accept = vi.spyOn(api, "acceptInvite").mockResolvedValue(coach);
  const done = vi.fn();
  show(<InviteAcceptScreen token="opaque-coach-token" onDone={done} />);
  expect(screen.getByText(/create your account/)).toBeTruthy();
  expect(screen.queryByText(/athlete account/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "coach" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
  fireEvent.click(screen.getByRole("button", { name: "Join and log in" }));
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  expect(accept).toHaveBeenCalledWith({ token: "opaque-coach-token", username: "coach", password: "password123" });
});

it("explains an expired invite and stays on the form", async () => {
  vi.spyOn(api, "acceptInvite").mockRejectedValue(new ApiError(410, "Gone"));
  const done = vi.fn();
  show(<InviteAcceptScreen token="old" onDone={done} />);
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "archer" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
  fireEvent.click(screen.getByRole("button", { name: "Join and log in" }));
  expect((await screen.findByRole("alert")).textContent).toContain("expired or was already used");
  expect(done).not.toHaveBeenCalled();
});

it("describes bootstrap as ownership of a shared team", async () => {
  vi.spyOn(api, "authStatus").mockResolvedValue({ setupRequired: true });
  show(<AuthScreen onAuthed={() => {}} />);
  await screen.findByText(/first coach owns this team/);
  expect(screen.getByText(/All coaches share/)).toBeTruthy();
});
