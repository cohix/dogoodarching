import { type Tracker } from "../../lib/types";
import { useEscapeToClose } from "../../components/useEscapeToClose";
import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api";
import { Empty } from "../../components/Empty";
import { CheckRow } from "../../components/CheckRow";
import { notFoundAware } from "../../lib/mutations";

type Setup = Tracker["setups"][number];

type SetupDraft = Omit<Setup, "id" | "updatedAt"> & { id?: number };

type SetupTextKey = Exclude<keyof SetupDraft, "id" | "poundage" | "name" | "sightMarks">;

type MaintenanceSection = Tracker["maintenanceItems"][number]["section"];

const maintenanceSections: MaintenanceSection[] = ["Weekly", "Monthly", "Quarterly"];

const blankSetup = (poundage: number | null): Omit<Setup, "id" | "updatedAt"> => ({ poundage: poundage ?? 0, name: poundage === null ? "New setup" : `${poundage} lb setup`, limbRiser: "", tillerBolts: "", braceHeight: "", stringTwists: "", nockingPoint: "", centerShot: "", plunger: "", gripNotes: "", stabilizer: "", clickerPosition: "", bareShaft: "", walkBack: "", arrowsInUse: "", sightMarks: {} });

const setupFields: [SetupTextKey, string, string][] = [["limbRiser", "Limbs / riser", "Models, length"], ["tillerBolts", "Tiller bolts", "Turns or measured position"], ["braceHeight", "Brace height", "mm"], ["stringTwists", "String twists", "Count"], ["nockingPoint", "Nocking point", "Height"], ["centerShot", "Center shot", "Position"], ["plunger", "Plunger", "Spring / tension"], ["stabilizer", "Stabilizer", "Long rod, side rods, V-bar"], ["clickerPosition", "Clicker position", "Reference"], ["arrowsInUse", "Arrows in use", "Shaft, spine, point"], ["gripNotes", "Grip notes", "Fit and pressure"], ["bareShaft", "Bare-shaft tune", "Result and date"], ["walkBack", "Walk-back tune", "Result and date"]];

const setupDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));

function SetupDetails({ setup, onClose }: { setup: Setup; onClose: () => void }) {
  useEscapeToClose(onClose);
  const populatedFields = setupFields.filter(([key]) => String(setup[key] ?? "").trim());
  const sightMarks = Object.entries(setup.sightMarks).filter(([, value]) => value.trim());
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="setup-details-title" onClick={onClose}>
    <article className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-5 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:pb-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">{setup.poundage} lb · Updated {setupDate(setup.updatedAt)}</p><h2 id="setup-details-title" className="mt-1 text-2xl font-extrabold leading-8 tracking-[-.02em]">{setup.name}</h2></div><button type="button" onClick={onClose} aria-label="Close setup details" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      {populatedFields.length ? <dl className="mt-5 divide-y divide-[var(--border)]">{populatedFields.map(([key, label]) => <div key={key as string} className="grid gap-1 py-3 sm:grid-cols-[150px_1fr]"><dt className="text-xs font-bold text-[var(--dim)]">{label}</dt><dd className="whitespace-pre-line text-sm leading-6">{String(setup[key])}</dd></div>)}</dl> : <p className="mt-5 text-sm text-[var(--dim)]">No equipment details have been recorded for this setup yet.</p>}
      {sightMarks.length > 0 && <section className="mt-5 border-t border-[var(--border)] pt-5"><h3 className="section-title">Sight marks</h3><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{sightMarks.map(([distance, value]) => <div key={distance} className="rounded-lg bg-[var(--surface-2)] p-3"><p className="text-xs font-bold text-[var(--dim)]">{distance} m</p><p className="mt-1 font-bold">{value}</p></div>)}</div></section>}
      <button type="button" onClick={onClose} className="mt-6 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button>
    </article>
  </div>;
}

function SetupEditor({ draft, setDraft, onCancel, onSave, saving }: { draft: SetupDraft; setDraft: (draft: SetupDraft) => void; onCancel: () => void; onSave: () => void; saving: boolean }) {
  return <form onSubmit={(event) => { event.preventDefault(); onSave(); }} className="card space-y-4 p-4"><div className="grid grid-cols-[1fr_100px] gap-3"><label><span className="label">Sheet name</span><input className="field" aria-label="Setup sheet name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span className="label">Poundage</span><input className="field" aria-label="Setup poundage" type="number" inputMode="numeric" min={1} max={100} step={1} required value={draft.poundage || ""} onChange={(event) => setDraft({ ...draft, poundage: Number(event.target.value) })} /></label></div><div className="grid gap-3 sm:grid-cols-2">{setupFields.map(([key, label, hint]) => <label key={key as string}><span className="label">{label}</span><textarea className="field min-h-16 resize-y" aria-label={label} placeholder={hint} value={String(draft[key] ?? "")} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} /></label>)}</div><fieldset><legend className="section-title mb-2">Sight marks</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[20, 30, 40, 50, 60, 70].map((distance) => <label key={distance}><span className="label">{distance} m</span><input className="field" aria-label={`${distance} metre sight mark`} value={draft.sightMarks[String(distance)] ?? ""} onChange={(event) => setDraft({ ...draft, sightMarks: { ...draft.sightMarks, [distance]: event.target.value } })} /></label>)}</div></fieldset><div className="flex gap-2"><button type="button" onClick={onCancel} className="flex-1 rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold">Cancel</button><button type="submit" disabled={saving} className="flex-[2] rounded-xl bg-[#17372a] px-4 py-3 text-sm font-bold text-white disabled:opacity-60">{saving ? "Saving…" : "Save setup"}</button></div></form>;
}

export function BowAndGear({ data, onSaved }: { data: Tracker; onSaved: () => void }) {
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [details, setDetails] = useState<Setup | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editingSection, setEditingSection] = useState<MaintenanceSection | null>(null);
  const [newItemLabel, setNewItemLabel] = useState("");
  const [editingItem, setEditingItem] = useState<{ id: number; label: string } | null>(null);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [setupMessage, setSetupMessage] = useState("");
  // Editing a setup that was deleted elsewhere answers 404: drop the draft and refetch.
  const save = useMutation({
    mutationFn: (value: SetupDraft) => api.saveSetup(value),
    onSuccess: () => { onSaved(); setDraft(null); setSetupMessage(""); },
    onError: notFoundAware(() => { onSaved(); setDraft(null); setSetupMessage("That setup no longer exists, so the list was refreshed."); }, () => setSetupMessage("Couldn’t save this setup. Try again.")),
  });
  const duplicate = useMutation({ mutationFn: (args: { id: number; poundage: number }) => api.duplicateSetup(args), onSuccess: onSaved });
  const toggleMaintenance = useMutation({ mutationFn: (args: { id: number; checked: boolean }) => api.setMaintenanceItemChecked(args), onSuccess: onSaved });
  const clearMaintenance = useMutation({ mutationFn: (section: MaintenanceSection) => api.clearMaintenanceSection({ section }), onSuccess: onSaved });
  const addMaintenance = useMutation({
    mutationFn: (args: { section: MaintenanceSection; label: string }) => api.addMaintenanceItem(args),
    onSuccess: () => { onSaved(); setNewItemLabel(""); setMaintenanceMessage("Item added"); },
    onError: () => setMaintenanceMessage("Couldn’t add that item. Try again."),
  });
  // 404 (item already gone, e.g. a double-tapped delete): refetch quietly instead of reporting an error.
  const updateMaintenance = useMutation({
    mutationFn: (args: { id: number; label: string }) => api.updateMaintenanceItem(args),
    onSuccess: () => { onSaved(); setEditingItem(null); setMaintenanceMessage("Item updated"); },
    onError: notFoundAware(() => { onSaved(); setEditingItem(null); setMaintenanceMessage(""); }, () => setMaintenanceMessage("Couldn’t update that item. Try again.")),
  });
  const deleteMaintenance = useMutation({
    mutationFn: (id: number) => api.deleteMaintenanceItem({ id }),
    onSuccess: () => { onSaved(); setEditingItem(null); setMaintenanceMessage("Item removed"); },
    onError: notFoundAware(() => { onSaved(); setEditingItem(null); setMaintenanceMessage(""); }, () => setMaintenanceMessage("Couldn’t remove that item. Try again.")),
  });
  const sortedSetups = [...data.setups].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const matchingCurrent = sortedSetups.find((setup) => setup.poundage === data.state.currentPoundage);
  const current = matchingCurrent ?? sortedSetups[0] ?? null;
  const history = current ? sortedSetups.filter((setup) => setup.id !== current.id) : [];
  const currentHighlights = current ? [
    { label: "Limbs / riser", value: current.limbRiser },
    { label: "Arrows", value: current.arrowsInUse },
    { label: "Brace height", value: current.braceHeight },
    { label: "Stabilizer", value: current.stabilizer },
    { label: "Clicker", value: current.clickerPosition },
  ].filter((item) => item.value.trim()).slice(0, 3) : [];

  useEffect(() => {
    if (!historyOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setHistoryOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [historyOpen]);

  return <div className="space-y-7">
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div><h2 className="section-title">Current bow setup</h2>{current && <p className="mt-1 text-xs text-[var(--dim)]">Updated {setupDate(current.updatedAt)}</p>}</div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => setHistoryOpen(true)} disabled={draft !== null} className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs font-bold disabled:opacity-45">History{history.length > 0 ? ` (${history.length})` : ""}</button>
          <button type="button" onClick={() => { setSetupMessage(""); setDraft(blankSetup(data.state.currentPoundage ?? current?.poundage ?? null)); }} disabled={draft !== null} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white disabled:opacity-45">New</button>
        </div>
      </div>
      {setupMessage && <p role="status" className="mb-2 text-xs font-semibold text-[var(--dim)]">{setupMessage}</p>}
      {draft ? <SetupEditor draft={draft} setDraft={setDraft} onCancel={() => { setDraft(null); setSetupMessage(""); }} onSave={() => save.mutate(draft)} saving={save.isPending} /> : current ? <div className="card relative overflow-hidden">
        <button type="button" onClick={() => setDetails(current)} className="block w-full p-4 pr-14 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]" aria-label={`View full setup details for ${current.name}`}>
          <p className="text-xl font-extrabold">{current.name}</p>
          {currentHighlights.length > 0 ? <dl className="mt-4 grid gap-3 sm:grid-cols-3">{currentHighlights.map((item) => <div key={item.label} className="min-w-0"><dt className="text-[11px] font-bold uppercase tracking-[.08em] text-[var(--dim)]">{item.label}</dt><dd className="mt-1 line-clamp-2 text-sm font-semibold leading-5">{item.value}</dd></div>)}</dl> : <p className="mt-2 text-sm text-[var(--dim)]">Tap to review the full setup.</p>}
          <p className="mt-4 text-xs font-bold text-[var(--accent)]">View full setup <span aria-hidden="true">→</span></p>
        </button>
        <button type="button" onClick={() => { setSetupMessage(""); setDraft(current); }} aria-label={`Edit ${current.name}`} title="Edit setup" className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text)]">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
      </div> : <Empty>No bow setup has been saved yet.</Empty>}
      {current && !draft && <button type="button" disabled={duplicate.isPending} onClick={() => duplicate.mutate({ id: current.id, poundage: current.poundage })} className="mt-2 w-full rounded-xl border border-[var(--border)] px-4 py-2.5 text-xs font-bold text-[var(--dim)] disabled:opacity-50">{duplicate.isPending ? "Duplicating…" : `Duplicate “${current.name}” at ${current.poundage} lb`}</button>}
    </section>

    <section aria-labelledby="maintenance-heading">
      <div className="mb-3"><h2 id="maintenance-heading" className="section-title">Maintenance log</h2><p className="mt-1 text-sm leading-6 text-[var(--dim)]">Tap an item as you finish it. Use the pencil to customize each cadence.</p></div>
      <div className="space-y-3">{maintenanceSections.map((period) => {
        const items = data.maintenanceItems.filter((item) => item.section === period);
        const done = items.filter((item) => item.checked).length;
        const editing = editingSection === period;
        return <article key={period} className="card p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-2"><h3 className="text-lg font-extrabold">{period}</h3><span className="text-xs font-bold text-[var(--dim)]">{done}/{items.length}</span></div>
            <div className="flex shrink-0 items-center gap-1.5">
              {done > 0 && <button type="button" disabled={clearMaintenance.isPending} onClick={() => clearMaintenance.mutate(period)} className="rounded-lg px-2.5 py-2 text-xs font-bold text-[var(--accent)] disabled:opacity-50" aria-label={`Clear completed ${period.toLowerCase()} maintenance items`}>Clear</button>}
              <button type="button" onClick={() => { setEditingSection(editing ? null : period); setEditingItem(null); setNewItemLabel(""); setMaintenanceMessage(""); }} aria-label={`${editing ? "Finish editing" : "Edit"} ${period.toLowerCase()} maintenance items`} aria-pressed={editing} className={`flex h-9 w-9 items-center justify-center rounded-full ${editing ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)] text-[var(--text)]"}`}>
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
            </div>
          </div>
          {items.length === 0 ? <p className="py-3 text-sm text-[var(--dim)]">No items in this section yet.</p> : <div className="divide-y divide-[var(--border)]">{items.map((item) => editingItem?.id === item.id ? <form key={item.id} className="space-y-2 py-3" onSubmit={(event) => { event.preventDefault(); const label = editingItem.label.trim(); if (label) updateMaintenance.mutate({ id: item.id, label }); }}>
            <label><span className="sr-only">Edit {item.label}</span><input autoFocus className="field" value={editingItem.label} onChange={(event) => setEditingItem({ id: item.id, label: event.target.value })} maxLength={160} /></label>
            <div className="flex justify-end gap-2"><button type="button" onClick={() => setEditingItem(null)} className="rounded-lg px-3 py-2 text-xs font-bold text-[var(--dim)]">Cancel</button><button type="submit" disabled={updateMaintenance.isPending || !editingItem.label.trim()} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">Save</button></div>
          </form> : <div key={item.id} className="flex items-center gap-2">
            <div className="min-w-0 flex-1"><CheckRow label={item.label} checked={item.checked} onChange={(checked) => toggleMaintenance.mutate({ id: item.id, checked })} /></div>
            {editing && <div className="flex shrink-0 items-center gap-1"><button type="button" onClick={() => setEditingItem({ id: item.id, label: item.label })} className="rounded-lg px-2 py-2 text-xs font-bold text-[var(--accent)]" aria-label={`Edit ${item.label}`}>Edit</button><button type="button" disabled={deleteMaintenance.isPending} onClick={() => deleteMaintenance.mutate(item.id)} className="rounded-lg px-2 py-2 text-xs font-bold text-[var(--dim)] disabled:opacity-50" aria-label={`Delete ${item.label}`}>Delete</button></div>}
          </div>)}</div>}
          {editing && <form className="mt-3 border-t border-[var(--border)] pt-3" onSubmit={(event) => { event.preventDefault(); const label = newItemLabel.trim(); if (label) addMaintenance.mutate({ section: period, label }); }}>
            <label><span className="label">New item</span><div className="flex gap-2"><input className="field min-w-0" value={newItemLabel} onChange={(event) => setNewItemLabel(event.target.value)} placeholder={`Add ${period.toLowerCase()} task`} maxLength={160} aria-label={`New ${period.toLowerCase()} maintenance item`} /><button type="submit" disabled={addMaintenance.isPending || !newItemLabel.trim()} className="shrink-0 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Add</button></div></label>
          </form>}
          {editing && maintenanceMessage && <p role="status" className="mt-2 text-xs text-[var(--dim)]">{maintenanceMessage}</p>}
        </article>;
      })}</div>
    </section>

    {details && <SetupDetails setup={details} onClose={() => setDetails(null)} />}
    {historyOpen && <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="setup-history-title" onClick={() => setHistoryOpen(false)}><article className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-5 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:pb-5" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">Previous configurations</p><h2 id="setup-history-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">Bow setup history</h2></div><button type="button" onClick={() => setHistoryOpen(false)} aria-label="Close bow setup history" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div><div className="mt-5 divide-y divide-[var(--border)]">{history.length === 0 ? <p className="py-8 text-center text-sm text-[var(--dim)]">Older setups will appear here when you save a new configuration.</p> : history.map((setup) => <div key={setup.id} className="flex items-center justify-between gap-3 py-4"><div><p className="font-bold">{setup.name}</p><p className="mt-0.5 text-xs text-[var(--dim)]">{setup.poundage} lb · Updated {setupDate(setup.updatedAt)}</p></div><button type="button" onClick={() => { setHistoryOpen(false); setDetails(setup); }} className="shrink-0 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs font-bold text-[var(--accent)]" aria-label={`View details for ${setup.name}`}>Details</button></div>)}</div><button type="button" onClick={() => setHistoryOpen(false)} className="mt-4 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button></article></div>}
  </div>;
}
