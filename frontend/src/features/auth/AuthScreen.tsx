import { type FormEvent, useState, useEffect } from "react";
import { api, ApiError } from "../../api";
import { useQueryClient } from "@tanstack/react-query";
import { resetAccount } from "../../lib/account";

function AuthFormCard({ title, subtitle, submitLabel, pending, error, onSubmit, username, setUsername, password, setPassword }: {
  title: string; subtitle: string; submitLabel: string; pending: boolean; error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  username: string; setUsername: (value: string) => void; password: string; setPassword: (value: string) => void;
}) {
  return <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 pb-safe pt-safe text-[var(--text)]">
    <div className="w-full max-w-sm">
      <p className="text-center text-xs font-bold uppercase tracking-[.16em] text-[var(--accent)]">Do Good Arching</p>
      <h1 className="mt-2 text-center text-3xl font-extrabold tracking-[-.03em]">{title}</h1>
      <p className="mt-2 text-center text-sm leading-6 text-[var(--dim)]">{subtitle}</p>
      <form onSubmit={onSubmit} className="card mt-6 space-y-4 p-5">
        <label><span className="label">Username</span><input className="field" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} maxLength={32} placeholder="3–32 chars: letters, numbers, _ or -" required /></label>
        <label><span className="label">Password</span><input className="field" type="password" maxLength={128} autoComplete={title === "Create coach account" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" required /></label>
        {error && <p role="alert" className="text-center text-xs font-semibold text-[var(--accent)]">{error}</p>}
        <button type="submit" disabled={pending} className="w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white disabled:opacity-50">{pending ? "Please wait…" : submitLabel}</button>
      </form>
    </div>
  </div>;
}

export function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"checking" | "bootstrap" | "login">("checking");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let live = true;
    api.authStatus()
      .then((status) => { if (live) setMode(status.setupRequired ? "bootstrap" : "login"); })
      .catch(() => { if (live) setError("Couldn’t reach the server. Check your connection and try again."); });
    return () => { live = false; };
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) { setError("Username must be 3–32 characters: letters, numbers, _ or -."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setPending(true);
    try {
      const me = mode === "bootstrap"
        ? await api.bootstrap({ username, password })
        : await api.login({ username, password });
      resetAccount(qc, me);
      onAuthed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  };
  if (mode === "checking") {
    if (error) {
      return <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 pb-safe pt-safe text-[var(--text)]">
        <div className="w-full max-w-sm text-center">
          <p className="text-xs font-bold uppercase tracking-[.16em] text-[var(--accent)]">Do Good Arching</p>
          <p role="alert" className="mt-3 text-sm leading-6">{error}</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Try again</button>
        </div>
      </div>;
    }
    return <div className="min-h-screen bg-[var(--bg)] p-6 pt-safe text-sm text-[var(--dim)]">Loading…</div>;
  }
  if (mode === "bootstrap") {
    return <AuthFormCard
      title="Create coach account" subtitle="No accounts exist yet. The first coach owns this team and can invite other coaches. All coaches share the team’s athletes."
      submitLabel="Create account" pending={pending} error={error} onSubmit={submit}
      username={username} setUsername={setUsername} password={password} setPassword={setPassword}
    />;
  }
  return <AuthFormCard
    title="Welcome back" subtitle="Log in to your training tracker."
    submitLabel="Log in" pending={pending} error={error} onSubmit={submit}
    username={username} setUsername={setUsername} password={password} setPassword={setPassword}
  />;
}

export function InviteAcceptScreen({ token, onDone }: { token: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) { setError("Username must be 3–32 characters: letters, numbers, _ or -."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setPending(true);
    try {
      const me = await api.acceptInvite({ token, username, password });
      resetAccount(qc, me);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setError("This invite has expired or was already used. Ask your coach for a new one.");
      } else {
        setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      }
    } finally {
      setPending(false);
    }
  };
  return <AuthFormCard
    title="Join your team" subtitle="You’re invited to Do Good Arching. Pick a username and password to create your account."
    submitLabel="Join and log in" pending={pending} error={error} onSubmit={submit}
    username={username} setUsername={setUsername} password={password} setPassword={setPassword}
  />;
}
