// An SDK reference operation's code panel (src/components/OperationPanel.astro). On a wide screen it is the right
// column, fixed beside the page; below 72rem it moves into the page, to the slot after the opening, and back again
// when the screen widens. The example buttons show one example; following an Examples heading's link, or clicking the
// heading, shows that example.

const panel = document.querySelector<HTMLElement>('[data-operation-panel]');
if (panel) {
  const home = panel.parentElement!;
  const slot = document.querySelector<HTMLElement>('[data-operation-panel-slot]');
  const wide = matchMedia('(min-width: 72rem)');
  const place = () => {
    if (wide.matches) home.append(panel);
    else slot?.append(panel);
  };
  place();
  wide.addEventListener('change', place);

  const choices = [...panel.querySelectorAll<HTMLButtonElement>('[data-example-choice]')];
  const bodies = [...panel.querySelectorAll<HTMLElement>('[data-example]')];
  const titled = bodies.filter((b) => b.dataset.exampleTitle);
  const show = (i: number) => {
    for (const b of bodies) b.hidden = b.dataset.example !== String(i);
    for (const c of choices) c.setAttribute('aria-pressed', String(c.dataset.exampleChoice === String(i)));
  };
  for (const c of choices) c.addEventListener('click', () => show(Number(c.dataset.exampleChoice)));

  // The Examples headings choose the example of the same title
  const headings = [...document.querySelectorAll<HTMLElement>('.sl-markdown-content h3')];
  const indexOf = (h: Element) => titled.findIndex((b) => b.dataset.exampleTitle === h.textContent?.trim());
  for (const h of headings) {
    const i = indexOf(h);
    if (i < 0) continue;
    (h.closest('.sl-heading-wrapper') ?? h).addEventListener('click', () => show(i));
  }
  const fromHash = () => {
    const target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    const i = target ? indexOf(target) : -1;
    if (i >= 0) show(i);
  };
  fromHash();
  addEventListener('hashchange', fromHash);
}
