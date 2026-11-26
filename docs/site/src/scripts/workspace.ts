// The reader's workspace hostname, one setting for the whole site. The Workspace box (src/components/ServerBlock.astro)
// on the SDK reference's operation pages and the API reference is where it is typed; every code block on the site, the
// guides included, then shows it in place of your-company.caitlyn.ai, and so does what its copy button copies.
// Kept in localStorage, so it lasts across pages and visits in this browser and is never sent anywhere. A value that is
// not a hostname is marked invalid and changes nothing; an empty field goes back to the placeholder.
import { WORKSPACE_PLACEHOLDER } from './workspace-placeholder';

const STORE = 'caitlyn-docs-workspace';

/** A hostname from what the reader typed: a pasted URL is reduced to its host, as the SDKs do. '' when there is
 * none, null when it is not a hostname. */
export function hostname(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return '';
  const host = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0];
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/.test(host) ? host : null;
}

function stored(): string {
  try {
    return hostname(localStorage.getItem(STORE) ?? '') ?? '';
  } catch {
    return '';
  }
}

function store(host: string): void {
  try {
    if (host) localStorage.setItem(STORE, host);
    else localStorage.removeItem(STORE);
  } catch {
    // private windows and blocked storage: the value lasts for this page only
  }
}

// Every place the placeholder appears in code, with its text as written, so a new value always replaces the original
const texts: { node: Text; original: string }[] = [];
const copies: { el: HTMLElement; original: string }[] = [];
for (const root of document.querySelectorAll('pre, [data-workspace-host]')) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.data.includes(WORKSPACE_PLACEHOLDER)) texts.push({ node: t, original: t.data });
  }
}
for (const el of document.querySelectorAll<HTMLElement>('[data-code]')) {
  if (el.dataset.code?.includes(WORKSPACE_PLACEHOLDER)) copies.push({ el, original: el.dataset.code });
}
const inputs = [...document.querySelectorAll<HTMLInputElement>('[data-workspace-input]')];

function apply(host: string): void {
  const value = host || WORKSPACE_PLACEHOLDER;
  for (const t of texts) t.node.data = t.original.replaceAll(WORKSPACE_PLACEHOLDER, value);
  for (const c of copies) c.el.dataset.code = c.original.replaceAll(WORKSPACE_PLACEHOLDER, value);
  document.documentElement.toggleAttribute('data-workspace', !!host);
}

const initial = stored();
apply(initial);
for (const input of inputs) {
  input.value = initial;
  input.addEventListener('input', () => {
    const host = hostname(input.value);
    input.setAttribute('aria-invalid', String(host === null));
    if (host === null) return;
    store(host);
    apply(host);
    for (const other of inputs) if (other !== input) other.value = host;
  });
  // On leaving the field, show the hostname as it is kept (a pasted URL reduced to its host)
  input.addEventListener('change', () => {
    const host = hostname(input.value);
    if (host !== null) input.value = host;
  });
}
// Another tab changed it
addEventListener('storage', (e) => {
  if (e.key !== STORE) return;
  const host = stored();
  apply(host);
  for (const input of inputs) {
    input.value = host;
    input.removeAttribute('aria-invalid');
  }
});
