// The site's code language, language tabs and fragment links. The Markdown has every language's code
// (src/plugins/remark-lang-tabs.mjs); this shows one language at a time and keeps every tab group, the code
// panel's language menu (src/components/LanguageSelect.astro) and anything marked data-lang-only in step. The language is
// <html data-lang>, which an inline script in the head sets before the page paints (astro.config.mjs), so text
// marked data-lang-only never flashes another language.
//
// Which language a group opens on, first match wins:
//   1. the one holding the target of a `:~:text=` link (a citation from Ask Caitlyn quotes the code it means);
//   2. `?lang=<key>` in the URL (typescript, python, go, rust, curl, cli);
//   3. the reader's last choice on this site (localStorage);
//   4. the first tab.
// Browsers scroll to a `:~:text=` target themselves, but not into a panel that is hidden, and some browsers do
// not support text fragments at all. In both cases this script finds the text, scrolls to it and highlights it.
//
// Output tabs (a CLI command's table, JSON or YAML: `tab-output=` blocks) and install tabs (how to install the CLI:
// `tab-install=` blocks) are separate choices, each picked the same way: the `:~:text=` target's panel, then
// `?output=<key>` or `?install=<key>`, then the reader's last choice of that kind (each stored apart from the language
// and from each other, so choosing one never changes another), then Table for output, and the reader's operating
// system for install.

import { setPicker } from './language-select';

const STORE = 'caitlyn-docs-lang';
const OUTPUT_STORE = 'caitlyn-docs-output';
const INSTALL_STORE = 'caitlyn-docs-install';
const HIGHLIGHT = 'caitlyn-fragment';

interface TextDirective {
  prefix?: string;
  start: string;
  end?: string;
  suffix?: string;
}

function stored(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

function store(name: string, key: string): void {
  try {
    localStorage.setItem(name, key);
  } catch {
    // private windows and blocked storage: the choice lasts for this page only
  }
}

const storedLang = () => stored(STORE);
const storeLang = (key: string) => store(STORE, key);

/** The `:~:text=` directives of the URL the page was opened with (browsers remove them from location.hash). */
function textDirectives(): TextDirective[] {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const url = nav?.name ?? location.href;
  const at = url.indexOf(':~:');
  if (at < 0) return [];
  return url
    .slice(at + 3)
    .split('&')
    .filter((p) => p.startsWith('text='))
    .map((p) => {
      const parts = p.slice(5).split(',').map((s) => decodeURIComponent(s));
      const d: TextDirective = { start: '' };
      if (parts[0]?.endsWith('-')) d.prefix = parts.shift()!.slice(0, -1);
      if (parts.at(-1)?.startsWith('-')) d.suffix = parts.pop()!.slice(1);
      d.start = parts[0] ?? '';
      if (parts[1]) d.end = parts[1];
      return d;
    })
    .filter((d) => d.start);
}

/** The text of the page's content and, for each character, the text node and offset it came from. */
function textIndex(root: Element): { text: string; at: (i: number) => [Text, number] } {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.parentElement?.closest('script, style, .lang-tab-list')) continue;
    nodes.push(t);
    starts.push(text.length);
    text += t.data;
  }
  const at = (i: number): [Text, number] => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= i) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo]!, i - starts[lo]!];
  };
  return { text, at };
}

/** Whitespace-insensitive, case-insensitive search: the [start, end) of `needle` in `hay` from `from`, or null. */
function find(hay: string, needle: string, from: number): [number, number] | null {
  const words = needle.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length || !words[0]) return null;
  const re = new RegExp(words.join('\\s+'), 'giu');
  re.lastIndex = from;
  const m = re.exec(hay);
  return m ? [m.index, m.index + m[0].length] : null;
}

/** The range a directive names in the content, following the text fragments spec closely enough for docs. */
function locate(index: { text: string; at: (i: number) => [Text, number] }, d: TextDirective): Range | null {
  const { text } = index;
  let from = 0;
  while (from <= text.length) {
    let startAt = from;
    if (d.prefix) {
      const p = find(text, d.prefix, from);
      if (!p) return null;
      const s = find(text, d.start, p[1]);
      if (!s || text.slice(p[1], s[0]).trim()) {
        from = p[0] + 1;
        continue;
      }
      startAt = s[0];
    }
    const s = find(text, d.start, startAt);
    if (!s) return null;
    let end = s[1];
    if (d.end) {
      const e = find(text, d.end, s[1]);
      if (!e) return null;
      end = e[1];
    }
    if (d.suffix) {
      const x = find(text, d.suffix, end);
      if (!x || text.slice(end, x[0]).trim()) {
        from = s[0] + 1;
        continue;
      }
    }
    const range = document.createRange();
    range.setStart(...index.at(s[0]));
    range.setEnd(...index.at(end - 1));
    range.setEnd(range.endContainer, range.endOffset + 1);
    return range;
  }
  return null;
}

/** Shows the tab and panel whose `data-<attr>` is key: lang for language tabs, output and install for those. */
function activate(group: Element, key: string, attr: 'lang' | 'output' | 'install' = 'lang'): boolean {
  const tabs = [...group.querySelectorAll<HTMLButtonElement>(':scope > .lang-tab-list > .lang-tab')];
  if (!tabs.some((t) => t.dataset[attr] === key)) return false;
  for (const tab of tabs) {
    const on = tab.dataset[attr] === key;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const panel of group.querySelectorAll<HTMLElement>(':scope > .lang-panel')) panel.hidden = panel.dataset[attr] !== key;
  return true;
}

/** A choice with tabs of its own (output, install), never the language's: `attr` names its data attribute, `name` its
 * stored key, `param` its URL parameter, and `fallback` the tab when nothing else says which. `pinnedTo` is a group's
 * panel holding a `:~:text=` target. */
function setUpChoice(attr: 'output' | 'install', name: string, param: string, fallback: () => string, pinnedTo: (group: Element) => string | undefined): void {
  const groups = [...document.querySelectorAll(`[data-${attr}-tabs]`)];
  if (!groups.length) return;
  const preferred = new URLSearchParams(location.search).get(param) ?? stored(name) ?? fallback();
  for (const group of groups) {
    const first = group.querySelector<HTMLElement>(':scope > .lang-panel')?.dataset[attr] ?? '';
    if (!activate(group, pinnedTo(group) ?? preferred, attr)) activate(group, first, attr);
    group.classList.add('lang-tabs-ready');
    for (const tab of group.querySelectorAll<HTMLButtonElement>(':scope > .lang-tab-list > .lang-tab')) {
      tab.addEventListener('click', () => {
        const chosen = tab.dataset[attr]!;
        store(name, chosen);
        const before = tab.getBoundingClientRect().top;
        for (const g of groups) activate(g, chosen, attr);
        window.scrollBy(0, tab.getBoundingClientRect().top - before);
      });
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const tabs = [...group.querySelectorAll<HTMLButtonElement>(':scope > .lang-tab-list > .lang-tab')];
        const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
        next.click();
        next.focus();
      });
    }
  }
}

/** The install tab for the reader's operating system, when they have chosen none: Windows, else macOS and Linux. */
function installForThisSystem(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || navigator.userAgent;
  return /win/i.test(platform) ? 'windows' : 'macos-and-linux';
}

// curl is the API reference's: chosen there, it is the site's language, and wherever curl is not offered (the SDK
// reference, a guide's tabs) TypeScript shows in its place (src/styles/components.css). cli, the CLI's command line, is
// offered on the references' operation pages wherever the CLI has a command for the example, with the same fallback.
const LANGUAGES = ['typescript', 'python', 'go', 'rust', 'curl', 'cli'];

/** Makes a language the site's: on the page root, in every language menu (which shows TypeScript when it has no
 * curl), and remembered. */
function setSiteLang(key: string, remember: boolean): void {
  if (!LANGUAGES.includes(key)) return;
  document.documentElement.dataset.lang = key;
  for (const picker of document.querySelectorAll<HTMLElement>('caitlyn-language-select')) setPicker(picker, key);
  if (remember) storeLang(key);
}

function setUp(): void {
  const groups = [...document.querySelectorAll('[data-lang-tabs]')];
  const content = document.querySelector('main') ?? document.body;
  const directives = textDirectives();
  const index = directives.length ? textIndex(content) : null;
  const targets = index ? directives.map((d) => locate(index, d)).filter((r): r is Range => !!r) : [];

  const fromUrl = new URLSearchParams(location.search).get('lang');
  const preferred = fromUrl ?? storedLang();
  setSiteLang(preferred ?? LANGUAGES[0]!, false);
  // A language chosen in a code panel's menu (src/scripts/language-select.ts)
  document.addEventListener('caitlyn-lang', (e) => {
    const key = (e as CustomEvent<string>).detail;
    setSiteLang(key, true);
    for (const g of groups) activate(g, key);
  });
  const pinned = new Map<Element, string>();
  const pinnedOutput = new Map<Element, string>();
  const pinnedInstall = new Map<Element, string>();
  for (const range of targets) {
    const panel = (range.startContainer.parentElement ?? null)?.closest<HTMLElement>('.lang-panel');
    const group = panel?.parentElement;
    if (panel?.dataset.lang && group && !pinned.has(group)) pinned.set(group, panel.dataset.lang);
    if (panel?.dataset.output && group && !pinnedOutput.has(group)) pinnedOutput.set(group, panel.dataset.output);
    if (panel?.dataset.install && group && !pinnedInstall.has(group)) pinnedInstall.set(group, panel.dataset.install);
  }
  setUpChoice('output', OUTPUT_STORE, 'output', () => 'table', (g) => pinnedOutput.get(g));
  setUpChoice('install', INSTALL_STORE, 'install', installForThisSystem, (g) => pinnedInstall.get(g));

  for (const group of groups) {
    const first = group.querySelector<HTMLElement>(':scope > .lang-panel')?.dataset.lang ?? '';
    const key = pinned.get(group) ?? preferred ?? first;
    if (!activate(group, key)) activate(group, first);
    group.classList.add('lang-tabs-ready');
    for (const tab of group.querySelectorAll<HTMLButtonElement>(':scope > .lang-tab-list > .lang-tab')) {
      tab.addEventListener('click', () => {
        const chosen = tab.dataset.lang!;
        setSiteLang(chosen, true);
        // Keep the clicked tab where it is on screen while every group on the page switches
        const before = tab.getBoundingClientRect().top;
        for (const g of groups) activate(g, chosen);
        window.scrollBy(0, tab.getBoundingClientRect().top - before);
      });
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const tabs = [...group.querySelectorAll<HTMLButtonElement>(':scope > .lang-tab-list > .lang-tab')];
        const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
        next.click();
        next.focus();
      });
    }
  }

  // The browser's own text fragment handling cannot reach a target that was in a hidden panel when the page
  // loaded, and some browsers have none: scroll to the first target and highlight every one.
  const native = 'fragmentDirective' in document;
  if (targets.length && (!native || pinned.size || pinnedOutput.size || pinnedInstall.size)) {
    const ranges = targets;
    const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
    const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (css?.highlights && HighlightCtor) css.highlights.set(HIGHLIGHT, new HighlightCtor(...ranges));
    const el = ranges[0]!.startContainer.parentElement;
    requestAnimationFrame(() => el?.scrollIntoView({ block: 'center', inline: 'nearest' }));
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setUp);
else setUp();
