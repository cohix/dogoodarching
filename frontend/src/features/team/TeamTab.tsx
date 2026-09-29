import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type AthleteSummary, type Invite, type Me, type Role } from "../../api";
import { useState } from "react";
import { Empty } from "../../components/Empty";
import { formatDate, localDate } from "../../lib/dates";
import { notFoundAware } from "../../lib/mutations";
import { PlanEditor } from "../plan/PlanEditor";
import { cyclePlanFor, plannedSessionsFor } from "../plan/defaults";
import { CycleSummaryCard } from "../dashboard/CycleHistoryModal";
import { ArrowHistoryModal } from "../log/ArrowHistoryModal";
import { ArrowsByWeekChart } from "../log/ArrowsByWeekChart";
import { coachTeamOverviewKey } from "../coach/CoachToday";

// One deployment is one team: every coach sees every athlete. The owner (the
// first coach) additionally invites coaches, sees the coach list, and sees and
// revokes every invite; other coaches see and revoke only their own invites.

const inviteStatus = (invite: Invite, now: number): "pending" | "used" | "expired" =>
  invite.usedAt !== null ? "used" : invite.expiresAt <= now ? "expired" : "pending";

const formatInstant = (epochMs: number) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(epochMs));

/**
 * `selectedAthleteId`/`onSelectAthlete` let the shell open an athlete's detail
 * (e.g. from a coach Today card) as in-app state. Without them TeamTab keeps
 * the selection itself.
 */
export function TeamTab({ me, selectedAthleteId, onSelectAthlete }: { me: Me; selectedAthleteId?: string | null; onSelectAthlete?: (athleteId: string | null) => void }) {
  const qc = useQueryClient();
  const [showDeactivated, setShowDeactivated] = useState(false);
  const [athleteMessage, setAthleteMessage] = useState("");
  const athletesQuery = useQuery({ queryKey: ["coach-athletes", { includeDeactivated: showDeactivated }], queryFn: () => api.listAthletes({ includeDeactivated: showDeactivated }) });
  const coachesQuery = useQuery({ queryKey: ["coach-coaches"], queryFn: () => api.listCoaches(), enabled: me.isOwner });
  // A /me refresh can reveal a transfer performed from another session. Do
  // not reuse the old owner's broader invite list after that role change.
  const invitesQuery = useQuery({ queryKey: ["invites", me.id, me.isOwner], queryFn: () => api.listInvites() });
  const [ownSelectedId, setOwnSelectedId] = useState<string | null>(null);
  const selectedId = onSelectAthlete ? (selectedAthleteId ?? null) : ownSelectedId;
  const setSelectedId = onSelectAthlete ?? setOwnSelectedId;
  const [inviteLink, setInviteLink] = useState<{ role: Role; url: string } | null>(null);
  const [inviteMessage, setInviteMessage] = useState("");
  const changeAthleteStatus = useMutation({
    mutationFn: (athlete: AthleteSummary) => athlete.deactivatedAt ? api.reactivateAthlete(athlete.id) : api.deactivateAthlete(athlete.id),
    onMutate: () => setAthleteMessage(""),
    onSuccess: async (athlete) => {
      setAthleteMessage(`${athlete.username} ${athlete.deactivatedAt ? "deactivated. Their data is kept and sign-in is disabled." : "reactivated. They can sign in again."}`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["coach-athletes"] }),
        qc.invalidateQueries({ queryKey: ["coach-overview", athlete.id] }),
        qc.invalidateQueries({ queryKey: [coachTeamOverviewKey] }),
      ]);
    },
    onError: (error) => setAthleteMessage(error instanceof ApiError ? error.message : "Couldn’t update this athlete. Try again."),
  });
  const refreshInvites = () => qc.invalidateQueries({ queryKey: ["invites"] });
  const createInvite = useMutation({
    mutationFn: (role: Role) => api.createInvite({ role }),
    onSuccess: (result, role) => {
      setInviteLink({ role, url: `${window.location.origin}${result.invitePath}` });
      setInviteMessage("");
      refreshInvites();
    },
    onError: (_error, role) => setInviteMessage(role === "coach" ? "Couldn’t create a coach invite. Only the owner can invite coaches." : "Couldn’t create an invite. Try again."),
  });
  const revokeInvite = useMutation({
    mutationFn: (id: string) => api.revokeInvite({ id }),
    onSuccess: () => { setInviteMessage("Invite revoked."); refreshInvites(); },
    // 404: already revoked (or not ours to revoke) — just refresh the list.
    onError: notFoundAware(() => { setInviteMessage(""); refreshInvites(); }, () => setInviteMessage("Couldn’t revoke that invite. Try again.")),
  });
  const copyInviteLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink.url);
      setInviteMessage(`Invite link copied — send it to the new ${inviteLink.role}.`);
    } catch {
      setInviteMessage("Copy didn’t work here — long-press the link to copy it.");
    }
  };
  const selected = athletesQuery.data?.athletes.find((athlete) => athlete.id === selectedId) ?? null;
  const now = Date.now();
  const invites = [...(invitesQuery.data ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const pendingInvites = invites.filter((invite) => inviteStatus(invite, now) === "pending");
  // Opened from coach Today: wait for the roster rather than flashing the list.
  if (selectedId && athletesQuery.isPending) return <Empty>Loading athlete…</Empty>;
  return <div className="space-y-5">
    {selected ? <AthleteDetail athlete={selected} onBack={() => setSelectedId(null)} /> : <>
      <section className="card p-4" aria-labelledby="invites-heading">
        <div className="flex items-start justify-between gap-3">
          <div><h2 id="invites-heading" className="section-title">Invites</h2><p className="mt-1 text-xs leading-5 text-[var(--dim)]">Single-use links, valid for 24 hours. Share them out-of-band.{me.isOwner ? " Coaches you invite share every athlete with you." : ""}</p></div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
            <button type="button" disabled={createInvite.isPending} onClick={() => createInvite.mutate("athlete")} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{createInvite.isPending && createInvite.variables === "athlete" ? "Creating…" : "+ Invite athlete"}</button>
            {me.isOwner && <button type="button" disabled={createInvite.isPending} onClick={() => createInvite.mutate("coach")} className="rounded-lg bg-[#17372a] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{createInvite.isPending && createInvite.variables === "coach" ? "Creating…" : "+ Invite coach"}</button>}
          </div>
        </div>
        {inviteLink && <div className="mt-3 space-y-2">
          <p className="text-xs font-bold">{inviteLink.role === "coach" ? "Coach invite" : "Athlete invite"}</p>
          <p className="break-all rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs font-mono">{inviteLink.url}</p>
          <button type="button" onClick={copyInviteLink} className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs font-bold">Copy link</button>
        </div>}
        {inviteMessage && <p role="status" className="mt-2 text-xs font-semibold text-[var(--dim)]">{inviteMessage}</p>}
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <h3 className="text-xs font-bold uppercase tracking-[.08em] text-[var(--dim)]">{me.isOwner ? "Pending invites" : "Your pending invites"}</h3>
          {invitesQuery.isPending ? <p className="mt-2 text-xs text-[var(--dim)]">Loading invites…</p>
            : invitesQuery.error ? <p className="mt-2 text-xs text-[var(--dim)]">Invites couldn’t be loaded. <button type="button" onClick={() => invitesQuery.refetch()} className="font-bold text-[var(--accent)]">Try again</button></p>
            : pendingInvites.length === 0 ? <p className="mt-2 text-xs text-[var(--dim)]">No pending invites.</p>
            : <ul className="mt-2 divide-y divide-[var(--border)]">{pendingInvites.map((invite) => <li key={invite.id} className="flex items-center justify-between gap-3 py-2"><div className="min-w-0"><p className="text-sm font-bold capitalize">{invite.role} invite</p><p className="text-xs text-[var(--dim)]">Created {formatInstant(invite.createdAt)} · expires {formatInstant(invite.expiresAt)}</p></div><button type="button" disabled={revokeInvite.isPending} onClick={() => revokeInvite.mutate(invite.id)} className="shrink-0 rounded-lg px-2 py-2 text-xs font-bold text-[var(--accent)] disabled:opacity-50" aria-label={`Revoke ${invite.role} invite created ${formatInstant(invite.createdAt)}`}>Revoke</button></li>)}</ul>}
          {invites.length > pendingInvites.length && <p className="mt-2 text-xs text-[var(--dim)]">{invites.length - pendingInvites.length} used or expired {invites.length - pendingInvites.length === 1 ? "invite is" : "invites are"} not shown.</p>}
        </div>
      </section>
      {me.isOwner && <section>
        <h2 className="section-title mb-2">Coaches</h2>
        {coachesQuery.isPending ? <Empty>Loading coaches…</Empty>
          : coachesQuery.error ? <div className="card p-4"><p className="text-sm text-[var(--text)]">Coaches couldn’t be loaded.</p><button type="button" onClick={() => coachesQuery.refetch()} className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white">Try again</button></div>
          : <div className="card divide-y divide-[var(--border)]">{coachesQuery.data.coaches.map((coach) => <div key={coach.id} className="flex items-center justify-between gap-3 p-4"><div className="min-w-0"><p className="font-bold">{coach.username}{coach.id === me.id && <span className="ml-2 text-xs font-semibold text-[var(--dim)]">(you)</span>}</p><p className="mt-0.5 text-xs text-[var(--dim)]">Joined {formatDate(coach.createdAt.slice(0, 10))}</p></div>{coach.isOwner && <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs font-bold text-[var(--accent)]">Owner</span>}</div>)}</div>}
      </section>}
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="section-title">Athletes</h2>
          <label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={showDeactivated} onChange={(event) => setShowDeactivated(event.target.checked)} />Show deactivated</label>
        </div>
        {athleteMessage && <p role="status" className="mb-3 text-sm text-[var(--dim)]">{athleteMessage}</p>}
        {athletesQuery.isPending ? <Empty>Loading athletes…</Empty>
          : athletesQuery.error ? <div className="card p-4"><p className="text-sm text-[var(--text)]">Athletes couldn’t be loaded.</p><button type="button" onClick={() => athletesQuery.refetch()} className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white">Try again</button></div>
          : athletesQuery.data.athletes.length === 0 ? <Empty>{showDeactivated ? "No athletes yet. Create an athlete invite above to add the first." : "No active athletes. Invite an athlete or turn on Show deactivated."}</Empty>
          : <div className="space-y-2">{athletesQuery.data.athletes.map((athlete) => <div key={athlete.id} className="card flex items-center gap-3 p-4">
            <button type="button" onClick={() => setSelectedId(athlete.id)} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open ${athlete.username}’s training overview`}>
              <p className="font-bold">{athlete.username}</p>
              {athlete.deactivatedAt && <p className="mt-1 text-xs font-bold text-[var(--accent)]">Deactivated</p>}
              <p className="mt-0.5 text-xs text-[var(--dim)]">Joined {formatDate(athlete.createdAt.slice(0, 10))}</p>
              <span className="mt-1 block text-xs font-bold text-[var(--accent)]">View overview →</span>
            </button>
            <button type="button" disabled={changeAthleteStatus.isPending} className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--accent)] disabled:opacity-50" aria-label={`${athlete.deactivatedAt ? "Reactivate" : "Deactivate"} ${athlete.username}`} onClick={() => {
              if (athlete.deactivatedAt || window.confirm(`Deactivate ${athlete.username}? They will be signed out and unable to sign in. Their training data will be kept.`)) changeAthleteStatus.mutate(athlete);
            }}>{changeAthleteStatus.isPending && changeAthleteStatus.variables.id === athlete.id ? "Updating…" : athlete.deactivatedAt ? "Reactivate" : "Deactivate"}</button>
          </div>)}</div>}
      </section>
    </>}
  </div>;
}

function AthleteDetail({ athlete, onBack }: { athlete: AthleteSummary; onBack: () => void }) {
  const qc = useQueryClient();
  const today = localDate();
  const [arrowHistoryOpen, setArrowHistoryOpen] = useState(false);
  const overview = useQuery({
    queryKey: ["coach-overview", athlete.id, today],
    queryFn: () => api.athleteOverview(athlete.id, today),
  });
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["coach-overview", athlete.id] }),
    qc.invalidateQueries({ queryKey: [coachTeamOverviewKey] }),
  ]);
  if (overview.isPending) return <div className="py-8 text-center text-sm text-[var(--dim)]">Loading {athlete.username}’s overview…</div>;
  if (!overview.data || overview.error) return <div className="card p-4"><button type="button" onClick={onBack} className="text-sm font-bold text-[var(--accent)]">← Back to team</button><p className="mt-3 text-sm text-[var(--text)]">This athlete’s overview couldn’t be loaded.</p><button type="button" onClick={() => overview.refetch()} className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white">Try again</button></div>;
  const o = overview.data;
  const totalArrows = o.weeklyArrows.reduce((sum, week) => sum + week.arrows, 0);
  const currentSummary = o.cycleSummaries.find((summary) => summary.cycle === o.state.currentCycle) ?? null;
  const earlierSummaries = o.cycleSummaries.filter((summary) => summary.cycle !== o.state.currentCycle).sort((a, b) => b.cycle - a.cycle);
  return <div className="space-y-6">
    <button type="button" onClick={onBack} className="text-sm font-bold text-[var(--accent)]">← Back to team</button>
    <div className="card p-4">
      <p className="text-xs font-bold uppercase tracking-[.16em] text-[var(--accent)]">Athlete</p>
      <h2 className="mt-1 text-2xl font-extrabold tracking-[-.02em]">{athlete.username}</h2>
      {athlete.deactivatedAt && <p className="mt-2 text-sm font-bold text-[var(--accent)]">Deactivated · history and plans are still available</p>}
      <p className="mt-1 text-xs text-[var(--dim)]">Cycle {o.state.currentCycle}, Week {o.state.currentWeek} · {o.state.currentPoundage === null ? "Poundage not set" : `${o.state.currentPoundage} lb`}</p>
      <p className="mt-2 text-xs leading-5 text-[var(--dim)]">Every coach can view and edit {athlete.username}’s training plans and summaries. Individual log entries, scores, notes, gear, and check-ins stay private to the athlete.</p>
    </div>
    <section aria-labelledby="current-cycle-heading">
      <h2 id="current-cycle-heading" className="section-title mb-2">Current cycle</h2>
      {currentSummary ? <CycleSummaryCard summary={currentSummary} currentWeek={o.state.currentWeek} /> : <Empty>No cycle data yet.</Empty>}
    </section>
    <section aria-labelledby="arrows-by-week-heading">
      <h2 id="arrows-by-week-heading" className="section-title mb-2">Arrows by week</h2>
      <div className="card p-4">
        <button type="button" onClick={() => setArrowHistoryOpen(true)} className="flex w-full items-center justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open ${athlete.username}’s arrows by week chart. ${totalArrows} arrows across ${o.weeklyArrows.length} logged weeks`}><p className="text-sm text-[var(--dim)]">{totalArrows} arrows across {o.weeklyArrows.length} logged {o.weeklyArrows.length === 1 ? "week" : "weeks"}</p><span className="shrink-0 text-sm font-bold text-[var(--accent)]">Full screen →</span></button>
        <ArrowsByWeekChart weeklyArrows={o.weeklyArrows} emptyText={`No logged weeks yet. The chart starts with ${athlete.username}’s first range log.`} className="mt-4" />
      </div>
    </section>
    <PlanEditor plans={cyclePlanFor(o)} plannedSessions={plannedSessionsFor(o)} state={o.state} onSaved={refresh} athleteId={athlete.id} />
    {earlierSummaries.length > 0 && <section aria-labelledby="earlier-cycles-heading">
      <h2 id="earlier-cycles-heading" className="section-title mb-2">Earlier cycles</h2>
      <div className="space-y-3">{earlierSummaries.map((summary) => <CycleSummaryCard key={summary.cycle} summary={summary} />)}</div>
    </section>}
    {arrowHistoryOpen && <ArrowHistoryModal weeklyArrows={o.weeklyArrows} emptyText={`The chart starts with ${athlete.username}’s first range log.`} onClose={() => setArrowHistoryOpen(false)} />}
  </div>;
}
