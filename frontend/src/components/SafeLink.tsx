// Defense-in-depth for every URL the SPA renders as a link (plan attachments,
// inspiration videos). The server already rejects non-http(s) links, but a
// stored value is never trusted as an href without passing through here.

/** Same-origin paths are only ever rendered when they point at an uploaded plan attachment. */
export const ATTACHMENT_PATH_PREFIX = "/api/plan/attachments/";

/**
 * Resolve `value` against the current origin and return a normalised absolute
 * href, or null when it must not be rendered as a link.
 *
 * Rules:
 * - empty, malformed, or non http/https values (`javascript:`, `data:`, `mailto:`, …) → null
 * - relative values (`/api/plan/attachments/7/file`) resolve against `window.location.origin`
 * - same-origin URLs are allowed only when their path starts with `/api/plan/attachments/`
 *   (a same-origin path outside it, including `/api/plan/attachmentsx`, is null)
 * - cross-origin http/https URLs are allowed as-is
 * - the return value is `url.href`, so `https://example.com` becomes `https://example.com/`
 *
 * Pure apart from reading `window.location.origin`, so it can be unit-tested under jsdom.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin === window.location.origin && !url.pathname.startsWith(ATTACHMENT_PATH_PREFIX)) return null;
  return url.href;
}

/** True when `href` (as returned by `safeHttpUrl`) points at this deployment. */
export function isSameOriginUrl(href: string): boolean {
  try {
    return new URL(href, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Renders nothing for unsafe URLs. Cross-origin links open in a new tab with
 * `noopener`. Same-origin file links are plain links: `target="_blank"` +
 * `noopener` can drop the session cookie in some installed-PWA contexts, and
 * the Worker serves attachments with `Content-Disposition: attachment`, so the
 * browser downloads the file without leaving the app.
 */
export function SafeLink({ url, className, children }: { url: string; className?: string; children: React.ReactNode }) {
  const href = safeHttpUrl(url);
  if (!href) return null;
  if (isSameOriginUrl(href)) return <a href={href} className={className}>{children}</a>;
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>;
}
