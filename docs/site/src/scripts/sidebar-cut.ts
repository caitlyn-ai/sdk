// A reference link in the sidebar that is cut with an ellipsis (src/styles/components.css) shows its full name in a
// one-line popover with an arrow pointing at the link, on hover and keyboard focus.
//
// The popover is one element in the top layer (the Popover API), so the sidebar's own scrolling and clipping never
// cut it, positioned from the link's box: to the link's right with the arrow pointing left, or below it with the
// arrow pointing up when there is no room to the right (the phone menu). CSS anchor positioning would do this without
// script but is not in every browser the site supports, and Floating UI would add a dependency for one tooltip. A
// browser without the Popover API gets the same element as a fixed layer. The link's own text is the full name, so
// a screen reader reads it whole and the popover is hidden from assistive technology.

const tip = document.createElement('div');
tip.className = 'caitlyn-tip';
tip.setAttribute('aria-hidden', 'true');
const popover = 'showPopover' in tip;
if (popover) tip.setAttribute('popover', 'manual');
const label = document.createElement('span');
tip.append(label);
document.body.append(tip);

function mark(): void {
  for (const a of document.querySelectorAll<HTMLElement>('.sidebar-content a[data-full]')) {
    const span = a.querySelector<HTMLElement>(':scope > span');
    a.toggleAttribute('data-cut', !!span && span.scrollWidth > span.clientWidth + 1);
  }
}

let current: HTMLElement | null = null;

/** Puts the popover beside the link: to its right, or below it when there is no room to the right */
function place(a: HTMLElement): void {
  const r = a.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const right = r.right + 12 + t.width <= innerWidth - 8;
  tip.dataset.side = right ? 'right' : 'below';
  const left = right ? r.right + 12 : Math.min(Math.max(8, r.left), innerWidth - t.width - 8);
  const top = right ? r.top + (r.height - t.height) / 2 : r.bottom + 10;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  // The arrow points at the link's start when the popover sits below it
  tip.style.setProperty('--arrow-x', `${Math.round(Math.min(Math.max(12, r.left + 24 - left), t.width - 12))}px`);
}

function show(a: HTMLElement): void {
  if (!a.hasAttribute('data-cut')) return;
  current = a;
  label.textContent = a.dataset.full ?? '';
  if (popover) {
    if (!tip.matches(':popover-open')) tip.showPopover();
  } else tip.classList.add('caitlyn-tip-open');
  place(a);
}

function hide(): void {
  current = null;
  if (popover && tip.matches(':popover-open')) tip.hidePopover();
  tip.classList.remove('caitlyn-tip-open');
}

/** On a scroll the popover follows its link, and goes when the link leaves the window */
function follow(): void {
  if (!current) return;
  const r = current.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) hide();
  else place(current);
}

mark();
addEventListener('resize', () => {
  mark();
  hide();
});
document.querySelector('#starlight__sidebar')?.addEventListener('toggle', mark);
for (const d of document.querySelectorAll('.sidebar-content details')) d.addEventListener('toggle', mark);
for (const a of document.querySelectorAll<HTMLElement>('.sidebar-content a[data-full]')) {
  a.addEventListener('mouseenter', () => show(a));
  a.addEventListener('focus', () => show(a));
  a.addEventListener('mouseleave', hide);
  a.addEventListener('blur', hide);
}
// Scrolls inside the sidebar do not bubble, so listen in the capture phase
addEventListener('scroll', follow, { capture: true, passive: true });
