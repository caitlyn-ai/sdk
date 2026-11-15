// A reference link in the sidebar that is cut with an ellipsis (src/styles/components.css) gets data-cut, which shows
// its full name in a tooltip on hover and keyboard focus. Measured on load, when the menu opens on a phone, and when
// the window resizes, so only a name that is actually cut gets one.
function mark(): void {
  for (const a of document.querySelectorAll<HTMLElement>('.sidebar-content a[data-full]')) {
    const span = a.querySelector<HTMLElement>(':scope > span');
    a.toggleAttribute('data-cut', !!span && span.scrollWidth > span.clientWidth + 1);
  }
}
mark();
addEventListener('resize', mark);
document.querySelector('#starlight__sidebar')?.addEventListener('toggle', mark);
for (const d of document.querySelectorAll('.sidebar-content details')) d.addEventListener('toggle', mark);
