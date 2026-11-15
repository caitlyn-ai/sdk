// An SDK reference operation's code panel (src/components/OperationPanel.astro). On a wide screen it is the right
// column, fixed beside the page; below 1249px (the API reference's own breakpoint) it moves into the page, to the slot after the opening, and back again
// when the screen widens. The example buttons show one example, and so does each example's title in the Examples
// section (a link to its heading), which is marked as the one shown.

const panel = document.querySelector<HTMLElement>('[data-operation-panel]');
if (panel) {
  const home = panel.parentElement!;
  const slot = document.querySelector<HTMLElement>('[data-operation-panel-slot]');
  const wide = matchMedia('(min-width: 1249px)');
  const place = () => {
    if (wide.matches) home.append(panel);
    else slot?.append(panel);
  };
  place();
  wide.addEventListener('change', place);

  const choices = [...panel.querySelectorAll<HTMLButtonElement>('[data-example-choice]')];
  const bodies = [...panel.querySelectorAll<HTMLElement>('[data-example]')];
  const titled = bodies.filter((b) => b.dataset.exampleTitle);
  // The Examples section's titles, each a link to its own heading (scripts/docs-reference.mjs)
  const headings = [...document.querySelectorAll<HTMLElement>('.sl-markdown-content h3')];
  const indexOf = (h: Element) => titled.findIndex((b) => b.dataset.exampleTitle === h.textContent?.trim());
  const links = headings.map((h) => ({ i: indexOf(h), h, a: h.querySelector<HTMLAnchorElement>(':scope > a[href^="#"]') })).filter((l) => l.i >= 0);
  // The response pane: a tab per documented status. Showing an example selects its own status; a status the example
  // does not have shows the operation's body for it (an example's, or the problem details every error has).
  const tabs = [...panel.querySelectorAll<HTMLButtonElement>('[data-status-tab]')];
  const pane = panel.querySelector<HTMLElement>('#caitlyn-op-response-pane');
  const answers = [...panel.querySelectorAll<HTMLElement>('[data-response]')];
  let current = 0;
  const showStatus = (status: string) => {
    const own = answers.find((a) => a.dataset.responseExample === String(current) && a.dataset.status === status);
    const shared = answers.find((a) => a.dataset.responseExample === undefined && a.dataset.status === status);
    const shown = own ?? shared;
    for (const a of answers) a.hidden = a !== shown;
    for (const t of tabs) {
      const on = t.dataset.statusTab === status;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on) pane?.setAttribute('aria-labelledby', t.id);
    }
  };
  for (const t of tabs) {
    t.addEventListener('click', () => showStatus(t.dataset.statusTab!));
    t.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      const at = tabs.indexOf(t);
      const next = tabs[step === -Infinity ? 0 : step === Infinity ? tabs.length - 1 : (at + step + tabs.length) % tabs.length]!;
      next.focus();
      showStatus(next.dataset.statusTab!);
    });
  }

  const show = (i: number) => {
    current = i;
    for (const b of bodies) b.hidden = b.dataset.example !== String(i);
    const status = bodies.find((b) => b.dataset.example === String(i) && b.dataset.exampleStatus)?.dataset.exampleStatus;
    if (status) showStatus(status);
    for (const c of choices) c.setAttribute('aria-pressed', String(c.dataset.exampleChoice === String(i)));
    // The example shown is the ink row in the Examples section, as the sidebar's current page
    for (const l of links) {
      if (l.i === i) l.a?.setAttribute('aria-current', 'true');
      else l.a?.removeAttribute('aria-current');
    }
  };
  for (const c of choices) c.addEventListener('click', () => show(Number(c.dataset.exampleChoice)));
  for (const l of links) {
    l.a?.addEventListener('click', (e) => {
      e.preventDefault();
      history.replaceState(history.state, '', `#${l.h.id}`);
      show(l.i);
      // In one column the panel is up the page: bring it into view with the example shown
      if (!wide.matches) panel.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
  }
  const fromHash = () => {
    const target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    const i = target ? indexOf(target) : -1;
    show(i >= 0 ? i : 0);
  };
  fromHash();
  addEventListener('hashchange', fromHash);
}
