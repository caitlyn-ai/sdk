// What the developer site tells search engines (scripts/docs-build.mjs writes it). The live build (build.caitlyn.ai)
// publishes sitemap.xml, every page at its canonical address with the date its source last changed, and a robots.txt
// that names it. Every other build, a merge request's preview above all, is a copy of the site on another host: it
// publishes no sitemap, its robots.txt names none, and every page carries noindex (docs/site/astro.config.mjs), so a
// preview never competes with the live pages in search results.
//
// A build is the live one only when DOCS_LIVE is "on", which .gitlab-ci.yml sets for docs:build on the default branch
// and on a release's v* tag, and nowhere else. A build that does not say is treated as a preview: forgetting the
// variable hides a build from search engines rather than advertising a preview.
import { execFileSync } from 'node:child_process';

export const LIVE_URL = 'https://build.caitlyn.ai';

/** Is this the live build (DOCS_LIVE=on)? */
export const isLive = (env = process.env) => env.DOCS_LIVE === 'on';

/** The robots meta tag's content for every page of the build. */
export const robotsMeta = (live) => (live ? 'index, follow' : 'noindex, nofollow');

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** sitemap.xml for `urls`, each { loc, lastmod } (lastmod an ISO 8601 date or date-time). */
export function sitemapXml(urls) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${xml(u.loc)}</loc><lastmod>${xml(u.lastmod)}</lastmod></url>`),
    '</urlset>',
    '',
  ].join('\n');
}

/** robots.txt: the live build names its sitemap; any other build names none. Crawlers stay allowed on a preview, so
 * they can read the noindex each of its pages carries (a disallowed page can still be listed, from links to it). */
export function robotsTxt({ live, base = LIVE_URL }) {
  return ['User-agent: *', 'Allow: /', ...(live ? ['', `Sitemap: ${base}/sitemap.xml`] : []), ''].join('\n');
}

/**
 * The date each source last changed, from its newest commit (`git log -1 --format=%cI -- <paths>`). `sources` maps a
 * key to the repository paths behind it. A key git cannot date (no repository, as in a container that sees a worktree
 * without its .git directory, or paths no commit touches) gets `fallback`, the build's own date-time; `dated` says
 * which keys came from git.
 */
export function lastModified(sources, { cwd, fallback, git = gitDate }) {
  const dates = new Map();
  const dated = new Set();
  for (const [key, paths] of sources) {
    const d = git(paths, cwd);
    dates.set(key, d ?? fallback);
    if (d) dated.add(key);
  }
  return { dates, dated };
}

function gitDate(paths, cwd) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...paths], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch {
    return null;
  }
}
