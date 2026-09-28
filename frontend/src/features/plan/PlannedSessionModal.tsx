import { type PlannedSession, api, fileToBase64 } from "../../api";
import { useState, type FormEvent } from "react";
import { useEscapeToClose } from "../../components/useEscapeToClose";
import { useMutation } from "@tanstack/react-query";
import { SafeLink } from "../../components/SafeLink";

type PlannedSessionDraft = Pick<PlannedSession, "dayKey" | "sessionType" | "detail" | "prescription">;

export function PlannedSessionModal({ session, onClose, onSaved, athleteId }: { session: PlannedSession; onClose: () => void; onSaved: () => void; athleteId?: string }) {
  const [draft, setDraft] = useState<PlannedSessionDraft>({ dayKey: session.dayKey, sessionType: session.sessionType, detail: session.detail, prescription: session.prescription });
  const [editing, setEditing] = useState(false);
  const [linkLabel, setLinkLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [message, setMessage] = useState("");
  useEscapeToClose(onClose);
  const save = useMutation({
    mutationFn: () => athleteId ? api.coachSavePlannedSession(athleteId, draft) : api.savePlannedSession(draft),
    onSuccess: () => { onSaved(); setEditing(false); setMessage("Session updated"); },
    onError: () => setMessage("Couldn’t update this session. Try again."),
  });
  const addLink = useMutation({
    mutationFn: () => athleteId
      ? api.coachAddPlannedSessionLink(athleteId, { dayKey: session.dayKey, label: linkLabel.trim(), url: linkUrl.trim() })
      : api.addPlannedSessionLink({ dayKey: session.dayKey, label: linkLabel.trim(), url: linkUrl.trim() }),
    onSuccess: () => { onSaved(); setLinkLabel(""); setLinkUrl(""); setMessage("Link added"); },
    onError: () => setMessage("Couldn’t add that link. Check the address and try again."),
  });
  const addFile = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 8_000_000) throw new Error("too-large");
      const encoded = await fileToBase64(file);
      const args = { dayKey: session.dayKey, kind: (file.type.startsWith("image/") ? "photo" : "document") as "document" | "photo", label: file.name, mimeType: encoded.mimeType || "application/octet-stream", dataBase64: encoded.dataBase64 };
      return athleteId ? api.coachAddPlannedSessionFile(athleteId, args) : api.addPlannedSessionFile(args);
    },
    onSuccess: () => { onSaved(); setMessage("Attachment added"); },
    onError: (error) => setMessage(error instanceof Error && error.message === "too-large" ? "Choose a file smaller than 8 MB." : "Couldn’t add that file. Try again."),
  });
  const removeAttachment = useMutation({
    mutationFn: (id: number) => athleteId ? api.coachDeletePlannedSessionAttachment(athleteId, id) : api.deletePlannedSessionAttachment({ id }),
    onSuccess: () => { onSaved(); setMessage("Attachment removed"); },
    onError: () => setMessage("Couldn’t remove that attachment."),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (draft.sessionType.trim() && draft.detail.trim() && draft.prescription.trim()) save.mutate(); };
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="planned-session-title" onClick={onClose}>
    <article className="max-h-[94dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-4 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:p-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">{session.day} plan{session.updatedAt === null && " · Starter plan"}</p><h2 id="planned-session-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">{session.sessionType}</h2></div><button type="button" onClick={onClose} aria-label="Close planned session" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      {editing ? <form onSubmit={submit} className="mt-5 space-y-4">
        <label><span className="label">Activity</span><input autoFocus className="field" aria-label="Planned activity name" value={draft.sessionType} maxLength={80} onChange={(event) => setDraft({ ...draft, sessionType: event.target.value })} required /></label>
        <label><span className="label">Summary</span><input className="field" aria-label="Planned session summary" value={draft.detail} maxLength={200} onChange={(event) => setDraft({ ...draft, detail: event.target.value })} required /></label>
        <label><span className="label">Session details</span><textarea className="field min-h-32 resize-y leading-6" aria-label="Planned session details" value={draft.prescription} maxLength={3000} onChange={(event) => setDraft({ ...draft, prescription: event.target.value })} required /></label>
        <div className="flex gap-2"><button type="button" onClick={() => { setDraft({ dayKey: session.dayKey, sessionType: session.sessionType, detail: session.detail, prescription: session.prescription }); setEditing(false); setMessage(""); }} className="flex-1 rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold">Cancel</button><button type="submit" disabled={save.isPending} className="flex-[2] rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white disabled:opacity-50">{save.isPending ? "Saving…" : "Save changes"}</button></div>
      </form> : <div className="mt-5">
        <div className="flex items-start justify-between gap-4"><div><p className="text-lg font-bold">{session.detail}</p><p className="mt-3 whitespace-pre-line text-sm leading-6 text-[var(--dim)]">{session.prescription}</p>{session.updatedAt === null && <p className="mt-3 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs leading-5">This day still shows the generic starter plan. {athleteId ? "Edit it to set this athlete’s session; they can change it too." : "Edit it to make it your own; your coach can edit it too."}</p>}</div><button type="button" onClick={() => { setEditing(true); setMessage(""); }} aria-label={`Edit ${session.day} planned session`} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)]"><svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button></div>
      </div>}
      <section className="mt-6 border-t border-[var(--border)] pt-5" aria-labelledby="planned-session-attachments"><div className="flex items-baseline justify-between gap-3"><div><h3 id="planned-session-attachments" className="section-title">Attachments</h3><p className="mt-1 text-xs text-[var(--dim)]">Documents, photos, and reference links</p></div><label className="cursor-pointer rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs font-bold text-[var(--accent)]"><span>{addFile.isPending ? "Uploading…" : "+ File or photo"}</span><input className="sr-only" type="file" accept="image/*,.pdf,.doc,.docx,.txt,.rtf" disabled={addFile.isPending} aria-label="Add a document or photo" onChange={(event) => { const file = event.target.files?.[0]; if (file) addFile.mutate(file); event.currentTarget.value = ""; }} /></label></div>
        <div className="mt-4 space-y-2">
          {session.attachments.map((attachment) => <div key={attachment.id} className="flex items-center gap-3 rounded-xl bg-[var(--surface-2)] p-3"><span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface)] text-[10px] font-black uppercase text-[var(--accent)]">{attachment.kind === "photo" ? "IMG" : attachment.kind === "link" ? "URL" : "DOC"}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{attachment.label}</p><p className="text-xs capitalize text-[var(--dim)]">{attachment.kind}</p></div><SafeLink url={attachment.url} className="shrink-0 rounded-lg px-2 py-2 text-xs font-bold text-[var(--accent)]">Open</SafeLink><button type="button" disabled={removeAttachment.isPending} onClick={() => removeAttachment.mutate(attachment.id)} aria-label={`Remove ${attachment.label}`} className="shrink-0 rounded-lg px-2 py-2 text-xs font-bold text-[var(--dim)]">Remove</button></div>)}
          {session.attachments.length === 0 && <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--dim)]">No attachments yet.</p>}
        </div>
        <form className="mt-4 space-y-2" onSubmit={(event) => { event.preventDefault(); if (linkLabel.trim() && linkUrl.trim()) addLink.mutate(); }}><p className="label">Add a link</p><input className="field" aria-label="Link label" value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} placeholder="Name this reference" maxLength={160} /><div className="flex gap-2"><input className="field min-w-0" aria-label="Link address" type="url" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://…" required /><button type="submit" disabled={addLink.isPending || !linkLabel.trim() || !linkUrl.trim()} className="shrink-0 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white disabled:opacity-45">{addLink.isPending ? "Adding…" : "Add"}</button></div></form>
      </section>
      {message && <p role="status" className="mt-3 text-center text-xs font-semibold text-[var(--dim)]">{message}</p>}
      <button type="button" onClick={onClose} className="mt-5 w-full rounded-xl bg-[#17372a] px-4 py-3 text-sm font-extrabold text-white">Done</button>
    </article>
  </div>;
}
