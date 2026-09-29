import { type Me, api, ApiError } from "../../api";
import { useQueryClient, useMutation, useQuery, useIsMutating } from "@tanstack/react-query";
import { useState } from "react";
import { resetAccount } from "../../lib/account";

export function SettingsTab({ me }: { me: Me }) {
  const qc = useQueryClient();
  const accountPending = useIsMutating({ mutationKey: ["account"] }) > 0;
  const [exportMessage, setExportMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [importing, setImporting] = useState(false);
  const logout = useMutation({
    mutationKey: ["account"],
    mutationFn: () => api.logout(),
    onSuccess: () => resetAccount(qc),
  });
  const doExport = async () => {
    setExportMessage("");
    setExporting(true);
    try {
      const payload = await api.exportData();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `dga-export-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setExportMessage("Export downloaded.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) resetAccount(qc);
      setExportMessage("Couldn’t export your data. Try again.");
    } finally {
      setExporting(false);
    }
  };
  const handleImportFile = async (file: File) => {
    setImportMessage("");
    setImporting(true);
    try {
      if (file.size > 8_000_000) throw new Error("import-size");
      const text = await file.text();
      const parsed = JSON.parse(text) as { version?: unknown; data?: unknown };
      if (!parsed || parsed.version !== 1 || typeof parsed.data !== "object" || !parsed.data) {
        throw new Error("bad-format");
      }
      const confirmed = window.confirm("Importing replaces ALL of your current training data with this file’s contents. This can’t be undone. Continue?");
      if (!confirmed) return;
      await api.importData(parsed as { version: number; exportedAt: string; username: string; data: Record<string, unknown> });
      await qc.invalidateQueries({ queryKey: ["tracker"] });
      setImportMessage("Import complete — your data was replaced.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) resetAccount(qc);
      setImportMessage(error instanceof ApiError ? error.message
        : error instanceof Error && error.message === "import-size" ? "Import file is larger than 8 MB."
        : error instanceof Error && error.message === "bad-format"
        ? "That file isn’t a Do Good Arching export."
        : "That file couldn’t be imported. Check it’s a Do Good Arching export and try again.");
    } finally {
      setImporting(false);
    }
  };
  return <fieldset disabled={accountPending} className="min-w-0 space-y-5">
    <section className="card p-4">
      <h2 className="section-title">Account</h2>
      <p className="mt-2 text-lg font-extrabold">{me.username}</p>
      <p className="mt-0.5 text-xs capitalize text-[var(--dim)]">{me.role}</p>
    </section>
    <AccountControls me={me} />
    {/* Personal export/import is athlete-only: coaches have no personal training data. */}
    {me.role === "athlete" && <>
    <section className="card p-4">
      <h2 className="section-title">Export my data</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--dim)]">Download everything as JSON. File attachments (photos/documents) are not included in the export.</p>
      <button type="button" disabled={exporting} onClick={doExport} className="mt-3 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">{exporting ? "Preparing…" : "Download export"}</button>
      {exportMessage && <p role="status" className="mt-2 text-xs font-semibold text-[var(--dim)]">{exportMessage}</p>}
    </section>
    <section className="card p-4">
      <h2 className="section-title">Import data</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--dim)]">Restore from an export file. This replaces all of your current training data.</p>
      <label className="mt-3 inline-block cursor-pointer rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-bold">
        <span>{importing ? "Importing…" : "Choose export file"}</span>
        <input
          className="sr-only" type="file" accept="application/json,.json" disabled={importing} aria-label="Choose an export file to import"
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImportFile(file); event.currentTarget.value = ""; }}
        />
      </label>
      {importMessage && <p role="status" className="mt-2 text-xs font-semibold text-[var(--dim)]">{importMessage}</p>}
    </section>
    </>}
    <button type="button" disabled={logout.isPending} onClick={() => logout.mutate()} className="w-full rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold text-[var(--dim)] disabled:opacity-50">{logout.isPending ? "Logging out…" : "Log out"}</button>
    {logout.error && <p role="alert" className="text-sm text-[var(--accent)]">{accountError(logout.error)}</p>}
  </fieldset>;
}

const accountError = (error: unknown) => error instanceof ApiError ? error.message : "Couldn’t update your account. Try again.";
const accountButton = "rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50";

function AccountControls({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [transferPassword, setTransferPassword] = useState("");
  const [coachId, setCoachId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const coaches = useQuery({ queryKey: ["coach-coaches"], queryFn: () => api.listCoaches(), enabled: me.isOwner });
  // Coaches cannot be deactivated through the API; the server also rechecks
  // target eligibility inside the atomic transfer.
  const targets = (coaches.data?.coaches ?? []).filter((coach) => coach.id !== me.id);
  const start = () => { setError(""); setMessage(""); };
  const fail = (error: unknown) => setError(accountError(error));
  const password = useMutation({
    mutationKey: ["account"],
    mutationFn: () => api.changePassword({ currentPassword, newPassword }),
    onMutate: start,
    onError: fail,
    onSuccess: async () => {
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      setMessage("Password changed. Your other sessions have been signed out.");
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const logoutAll = useMutation({ mutationKey: ["account"], mutationFn: () => api.logoutAll(), onMutate: start, onError: fail, onSuccess: () => resetAccount(qc) });
  const deleteAccount = useMutation({ mutationKey: ["account"], mutationFn: () => api.deleteAccount({ password: deletePassword }), onMutate: start, onError: fail, onSuccess: () => resetAccount(qc) });
  const transfer = useMutation({
    mutationKey: ["account"],
    mutationFn: () => api.transferOwnership({ coachId, password: transferPassword }),
    onMutate: start,
    onError: async (error) => {
      fail(error);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["me"] }),
        qc.invalidateQueries({ queryKey: ["coach-coaches"] }),
      ]);
    },
    onSuccess: async () => {
      setTransferPassword(""); setCoachId("");
      await qc.cancelQueries({ queryKey: ["me"] });
      if (qc.getQueryData<Me | null>(["me"])?.id !== me.id) return;
      // Update the role immediately, then confirm it from the server. Discard
      // owner-only results (and old-owner invite permissions) on demotion.
      qc.setQueryData<Me>(["me"], { ...me, isOwner: false });
      qc.removeQueries({ queryKey: ["coach-coaches"] });
      qc.removeQueries({ queryKey: ["invites"] });
      setMessage("Ownership transferred. You remain a coach on the team.");
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const busy = password.isPending || logoutAll.isPending || deleteAccount.isPending || transfer.isPending;
  return <fieldset disabled={busy} className="min-w-0 space-y-5">
    <section className="card p-4">
      <h2 className="section-title">Change password</h2>
      <p className="mt-2 text-sm text-[var(--dim)]">Changing your password signs out your other sessions. You stay signed in here.</p>
      <form className="mt-3 space-y-3" onSubmit={(event) => {
        event.preventDefault();
        start();
        if (newPassword !== confirmPassword) { setError("New passwords do not match."); return; }
        password.mutate();
      }}>
        <label className="block"><span className="label">Current password</span><input className="field" type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
        <label className="block"><span className="label">New password</span><input className="field" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
        <label className="block"><span className="label">Confirm new password</span><input className="field" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
        <button type="submit" className={accountButton}>{password.isPending ? "Changing…" : "Change password"}</button>
      </form>
    </section>
    <section className="card p-4">
      <h2 className="section-title">Sessions</h2>
      <p className="mt-2 text-sm text-[var(--dim)]">Sign out on every device, including this one.</p>
      <button type="button" className={`mt-3 ${accountButton}`} onClick={() => logoutAll.mutate()}>{logoutAll.isPending ? "Signing out…" : "Sign out everywhere"}</button>
    </section>
    {me.isOwner ? <section className="card p-4">
      <h2 className="section-title">Transfer ownership</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--dim)]">Choose another coach to own the team. Your pending coach invites will stop working. Transfer ownership before you can delete your account.</p>
      {coaches.isPending ? <p className="mt-3 text-sm">Loading coaches…</p>
        : coaches.error ? <p role="alert" className="mt-3 text-sm">Coaches couldn’t be loaded. <button type="button" className="font-bold text-[var(--accent)]" onClick={() => coaches.refetch()}>Try again</button></p>
        : targets.length === 0 ? <p className="mt-3 text-sm text-[var(--dim)]">Invite another coach from the Team tab before transferring ownership.</p>
        : <form className="mt-3 space-y-3" onSubmit={(event) => {
          event.preventDefault();
          if (targets.some((coach) => coach.id === coachId)) transfer.mutate();
        }}>
          <label className="block"><span className="label">New owner</span><select className="field" required value={coachId} onChange={(event) => setCoachId(event.target.value)}><option value="">Choose a coach</option>{targets.map((coach) => <option key={coach.id} value={coach.id}>{coach.username}</option>)}</select></label>
          <label className="block"><span className="label">Password to confirm transfer</span><input className="field" type="password" autoComplete="current-password" required maxLength={128} value={transferPassword} onChange={(event) => setTransferPassword(event.target.value)} /></label>
          <button type="submit" className={accountButton}>{transfer.isPending ? "Transferring…" : "Transfer ownership"}</button>
        </form>}
    </section> : <section className="card p-4">
      <h2 className="section-title">Delete account</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--dim)]">{me.role === "coach" ? "Permanently delete your account. This cannot be undone. Athletes, their training data and the team meals you posted stay with the team." : "Permanently delete your account and your personal training data and files. This cannot be undone."}</p>
      <form className="mt-3 space-y-3" onSubmit={(event) => {
        event.preventDefault();
        if (window.confirm("Permanently delete your account and personal training data? This cannot be undone.")) deleteAccount.mutate();
      }}>
        <label className="block"><span className="label">Password to confirm deletion</span><input className="field" type="password" autoComplete="current-password" required maxLength={128} value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} /></label>
        <button type="submit" className={accountButton}>{deleteAccount.isPending ? "Deleting…" : "Delete account"}</button>
      </form>
    </section>}
    {error && <p role="alert" className="text-sm font-semibold text-[var(--accent)]">{error}</p>}
    {message && <p role="status" className="text-sm font-semibold text-[var(--dim)]">{message}</p>}
  </fieldset>;
}
