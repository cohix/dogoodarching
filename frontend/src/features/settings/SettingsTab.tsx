import { type Me, api } from "../../api";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { useState } from "react";

export function SettingsTab({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [exportMessage, setExportMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [importing, setImporting] = useState(false);
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => { qc.clear(); window.location.reload(); },
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
    } catch {
      setExportMessage("Couldn’t export your data. Try again.");
    } finally {
      setExporting(false);
    }
  };
  const handleImportFile = async (file: File) => {
    setImportMessage("");
    setImporting(true);
    try {
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
      setImportMessage(error instanceof Error && error.message === "bad-format"
        ? "That file isn’t a Do Good Arching export."
        : "That file couldn’t be imported. Check it’s a Do Good Arching export and try again.");
    } finally {
      setImporting(false);
    }
  };
  return <div className="space-y-5">
    <section className="card p-4">
      <h2 className="section-title">Account</h2>
      <p className="mt-2 text-lg font-extrabold">{me.username}</p>
      <p className="mt-0.5 text-xs capitalize text-[var(--dim)]">{me.role}</p>
    </section>
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
    <button type="button" disabled={logout.isPending} onClick={() => logout.mutate()} className="w-full rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold text-[var(--dim)] disabled:opacity-50">{logout.isPending ? "Logging out…" : "Log out"}</button>
  </div>;
}
