// Vercel Routing Middleware — NOT Astro's own middleware (that would live in
// src/middleware.ts). This one has to sit at the project root, next to
// package.json, or Vercel won't pick it up.
//
// Why this exists instead of vercel.json rewrites: Vercel's own docs for
// Astro are explicit that rewrites only reliably work for static files, and
// that host-conditional rewrites in vercel.json are not officially
// supported and produce inconsistent behavior on Astro projects — which is
// exactly what we saw (sub-paths rewrote fine, the exact "/" root did not,
// because a real index.html already exists there for the blog and Vercel
// serves that file directly before evaluating vercel.json rewrites).
// Routing Middleware runs earlier in the request lifecycle, before that
// static-file short-circuit, so it doesn't have this problem.
//
// Scope: only intercepts requests to rhythm.srinivasdasyam.com. Every other
// host (srinivasdasyam.com, any preview URL) falls through untouched — the
// blog's own routing and the existing srinivasdasyam.com/rhythm path both
// keep working exactly as before.
import { rewrite } from '@vercel/functions';
const RHYTHM_HOST = 'rhythm.srinivasdasyam.com';

// Node link short codes — internal codenames for node outreach links.
// A node poster only ever sees rhythm.srinivasdasyam.com/r/<code>. This
// table expands that code into the real utm_source / utm_medium /
// utm_campaign combination and redirects there, so index.html's existing
// attribution capture (reads window.location.search) still works exactly
// as before with zero changes to index.html.
//
// Code names are arbitrary and internal only — pick whatever's memorable
// (person's name + a number is the current convention). Add one line per
// new node or new post from an existing node, then push to main.
const NODE_LINKS: Record<string, { utm_source: string; utm_medium: string; utm_campaign: string }> = {
  a: { utm_source: 'arpan', utm_medium: 'node', utm_campaign: 'post1' },
  s: { utm_source: 'sumeeth', utm_medium: 'node', utm_campaign: 'post1' },
  arpan2: { utm_source: 'arpan', utm_medium: 'node', utm_campaign: 'post2' },
  test1: { utm_source: 'test', utm_medium: 'node', utm_campaign: 'post1' },
  // add new node codes here, e.g.:
  // srujan1: { utm_source: 'srujan', utm_medium: 'node', utm_campaign: 'post1' },
};

export default function middleware(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get('host') || '';
  if (host !== RHYTHM_HOST) {
    return; // not our host — let normal routing (blog, etc.) proceed
  }
  // API routes are Vercel Functions, not static files under public/rhythm/.
  // Never rewrite these — they need to hit /api/* directly on every host.
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  // Node link short codes — /r/<code>. Redirect (not rewrite) so the
  // attribution query string actually lands in the browser URL that
  // index.html's script reads from. Unknown codes fall through to the
  // catch-all below and 404 naturally rather than being force-handled here.
  const nodeMatch = url.pathname.match(/^\/r\/([a-zA-Z0-9_-]+)$/);
  if (nodeMatch && NODE_LINKS[nodeMatch[1]]) {
    const { utm_source, utm_medium, utm_campaign } = NODE_LINKS[nodeMatch[1]];
    const target = new URL('/rhythm/index.html', request.url);
    target.searchParams.set('utm_source', utm_source);
    target.searchParams.set('utm_medium', utm_medium);
    target.searchParams.set('utm_campaign', utm_campaign);
    return Response.redirect(target.toString(), 307);
  }
  // Legacy hardcoded paths already start with /rhythm/ — this is what
  // pay.html's SUCCESS_PATH and index.html's PAYWALL_PATH currently point
  // at (see the three MIGRATION DEPENDENCY comments). Pass these through
  // unchanged so both the old prefixed links and new clean links work on
  // the subdomain simultaneously, with no JS changes needed yet.
  if (url.pathname.startsWith('/rhythm/')) {
    return;
  }
  // Bare "/rhythm" (no trailing content) — same as the vercel.json rule
  // that already exists for the main domain.
  if (url.pathname === '/rhythm') {
    return rewrite(new URL('/rhythm/index.html', request.url));
  }
  // Clean root — this was the one vercel.json couldn't handle.
  if (url.pathname === '/') {
    return rewrite(new URL('/rhythm/index.html', request.url));
  }
  // Everything else clean: /pay.html, /success.html, /refund.html,
  // /terms.html, and anything else added under public/rhythm/ later.
  return rewrite(new URL(`/rhythm${url.pathname}`, request.url));
}
export const config = {
  matcher: '/:path*',
};