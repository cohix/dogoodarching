import { useState, useEffect } from "react";
import { type Tracker } from "../../lib/types";
import { Empty } from "../../components/Empty";
import { SafeLink } from "../../components/SafeLink";

type VideoSource = { embedUrl: string; sourceUrl: string; provider: "YouTube" | "Vimeo" };

function youtubeVideoSource(id: string, sourceUrl: string): VideoSource {
  const encodedId = encodeURIComponent(id);
  return {
    embedUrl: `https://www.youtube.com/embed/${encodedId}?playsinline=1&rel=0&controls=1`,
    sourceUrl,
    provider: "YouTube",
  };
}

function normalizeVideoSource(value: string): VideoSource | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathParts = url.pathname.split("/").filter(Boolean);

    if (host === "youtu.be") {
      const id = pathParts[0];
      return id ? youtubeVideoSource(id, value) : null;
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
      if (pathParts[0] === "embed" && pathParts[1]) {
        return youtubeVideoSource(pathParts[1], `https://www.youtube.com/watch?v=${encodeURIComponent(pathParts[1])}`);
      }
      const id = url.pathname === "/watch"
        ? url.searchParams.get("v")
        : pathParts[0] === "shorts" ? pathParts[1] : null;
      return id ? youtubeVideoSource(id, value) : null;
    }

    if (host === "player.vimeo.com" && pathParts[0] === "video" && /^\d+$/.test(pathParts[1] ?? "")) {
      return { embedUrl: value, sourceUrl: `https://vimeo.com/${pathParts[1]}`, provider: "Vimeo" };
    }
    if (host === "vimeo.com") {
      const id = pathParts.find((part) => /^\d+$/.test(part));
      return id ? { embedUrl: `https://player.vimeo.com/video/${id}`, sourceUrl: value, provider: "Vimeo" } : null;
    }

    return null;
  } catch {
    return null;
  }
}

function InlineVideo({ video, title }: { video: VideoSource; title: string }) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => setPlaying(false), [video.embedUrl]);
  const separator = video.embedUrl.includes("?") ? "&" : "?";
  const playerUrl = `${video.embedUrl}${separator}autoplay=1`;

  return <div className="relative aspect-video w-full overflow-hidden bg-[#111512] text-white">
    {playing ? <iframe
      className="absolute inset-0 h-full w-full border-0"
      src={playerUrl}
      title={`${title} — inline video player`}
      loading="eager"
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
      referrerPolicy="origin-when-cross-origin"
    /> : <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-label={`Play ${title} inline`}
      className="absolute inset-0 flex h-full w-full flex-col items-center justify-center gap-3 bg-[#111512] px-6 text-center"
    >
      <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-2xl text-[#111512]">▶</span>
      <span className="text-sm font-bold">Play video here</span>
    </button>}
  </div>;
}

export function Inspiration({ inspiration }: { inspiration: Tracker["inspiration"] }) {
  if (!inspiration) return <section><h2 className="section-title mb-2">Inspiration</h2><Empty>Your next daily check-in will appear here.</Empty></section>;
  const video = normalizeVideoSource(inspiration.videoUrl);
  const updated = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(inspiration.updatedAt));
  return <section aria-labelledby="inspiration-heading" className="space-y-3">
    <div className="flex items-end justify-between gap-3"><h2 id="inspiration-heading" className="section-title">Inspiration</h2><p className="text-xs text-[var(--dim)]">Updated {updated}</p></div>
    <article className="card p-5"><p className="text-xs font-black uppercase tracking-[.12em] text-[var(--accent)]">Thought for the day</p><blockquote className="mt-3 text-lg font-semibold leading-7 tracking-[-.01em]">{inspiration.thoughtText}</blockquote></article>
    <article className="card overflow-hidden">
      {video ? <InlineVideo video={video} title={inspiration.videoTitle} /> : <div className="flex aspect-video items-center justify-center bg-[var(--surface-2)] px-6 text-center text-sm text-[var(--dim)]">Inline playback isn’t available for this source.</div>}
      <div className="flex items-start justify-between gap-3 p-4"><div><p className="text-xs font-black uppercase tracking-[.12em] text-[var(--accent)]">Watch</p><h3 className="mt-1 font-bold leading-6">{inspiration.videoTitle}</h3></div><SafeLink url={video?.sourceUrl ?? inspiration.videoUrl} className="shrink-0 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs font-bold text-[var(--text)]">Open on {video?.provider ?? "source"}</SafeLink></div>
    </article>
    <article className="card p-5"><p className="text-xs font-black uppercase tracking-[.12em] text-[var(--accent)]">Power meal</p><h3 className="mt-2 text-xl font-extrabold tracking-[-.02em]">{inspiration.recipeName}</h3><p className="mt-2 text-sm leading-6 text-[var(--dim)]">{inspiration.recipeSummary}</p><div className="mt-4 border-t border-[var(--border)] pt-4"><p className="text-xs font-bold uppercase tracking-wider text-[var(--dim)]">Ingredients</p><p className="mt-1 whitespace-pre-line text-sm leading-6">{inspiration.recipeIngredients}</p></div></article>
  </section>;
}
