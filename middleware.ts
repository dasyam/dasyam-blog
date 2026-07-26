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

export default function middleware(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get('host') || '';

  if (host !== RHYTHM_HOST) {
    return; // not our host — let normal routing (blog, etc.) proceed
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