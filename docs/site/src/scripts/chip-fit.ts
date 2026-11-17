// A code chip (an operation's SDK call and HTTP line under its title, src/components/OperationHeader.astro) never
// scrolls. When its value does not fit the room it has, it is cut in the middle, keeping its start and its end:
// `caitlyn.knowledgeBases(knowledgeBaseId).fiel…fields.create()` keeps the last segment whole (`.create(…)`, `/fields`)
// and as much of the start as fits. It is worked out from the chip's width, again on resize and when the site's
// language changes (a chip in a hidden language has no width until it shows). A cut chip shows its whole value in a
// popover on hover and on focus; one that fits shows none. Clicking a chip, or Enter or Space on it, copies its whole
// value, with "Copied" on the chip and for a screen reader.

const chips = [...document.querySelectorAll<HTMLButtonElement>('[data-chip]')];
if (chips.length) {
  const tip = document.createElement('div');
  tip.className = 'caitlyn-tip caitlyn-chip-tip';
  tip.setAttribute('aria-hidden', 'true');
  const popover = 'showPopover' in tip;
  if (popover) tip.setAttribute('popover', 'manual');
  const tipText = document.createElement('span');
  tip.append(tipText);
  document.body.append(tip);
  const live = document.createElement('p');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  document.body.append(live);

  /** The value cut to `keep` characters of its start, an ellipsis, and its tail */
  const middle = (full: string, keep: number, tail: string) => `${full.slice(0, keep)}…${tail}`;
  /** The tail kept whole: the last call or path segment (`.create(…)`, `/fields`), or the last few characters */
  const tailOf = (full: string) => {
    const call = full.lastIndexOf('.', full.lastIndexOf('(') < 0 ? full.length : full.lastIndexOf('('));
    const slash = full.lastIndexOf('/');
    const at = Math.max(call, slash);
    return at > 0 && full.length - at < full.length / 2 ? full.slice(at) : full.slice(-12);
  };

  function fit(chip: HTMLButtonElement): void {
    const code = chip.querySelector<HTMLElement>('code');
    const text = chip.querySelector<HTMLElement>('.caitlyn-chip-text');
    if (!code || !text) return;
    const full = text.dataset.full ?? (text.dataset.full = text.textContent ?? '');
    text.textContent = full;
    // Hidden (another language's chip): fitted when it shows
    if (!code.offsetParent) return;
    const fits = () => code.scrollWidth <= code.clientWidth + 1;
    if (fits()) {
      chip.removeAttribute('data-cut');
      return;
    }
    let tail = tailOf(full);
    // The longest start that fits beside the tail; with no room for any, a shorter tail
    for (;;) {
      let lo = 0;
      let hi = full.length - tail.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        text.textContent = middle(full, mid, tail);
        if (fits()) lo = mid;
        else hi = mid - 1;
      }
      text.textContent = middle(full, lo, tail);
      if (lo > 0 || tail.length <= 4 || fits()) break;
      tail = tail.slice(Math.ceil(tail.length / 3));
    }
    chip.setAttribute('data-cut', '');
  }
  const fitAll = () => chips.forEach(fit);

  function show(chip: HTMLButtonElement): void {
    if (!chip.hasAttribute('data-cut')) return;
    tipText.textContent = chip.dataset.chip ?? '';
    if (popover) {
      if (!tip.matches(':popover-open')) tip.showPopover();
    } else tip.classList.add('caitlyn-tip-open');
    const r = chip.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    tip.dataset.side = 'below';
    const left = Math.min(Math.max(8, r.left), innerWidth - t.width - 8);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(r.bottom + 10)}px`;
    tip.style.setProperty('--arrow-x', `${Math.round(Math.min(Math.max(12, r.left + 24 - left), t.width - 12))}px`);
  }
  function hide(): void {
    if (popover && tip.matches(':popover-open')) tip.hidePopover();
    tip.classList.remove('caitlyn-tip-open');
  }

  for (const chip of chips) {
    chip.addEventListener('mouseenter', () => show(chip));
    chip.addEventListener('focus', () => show(chip));
    chip.addEventListener('mouseleave', hide);
    chip.addEventListener('blur', hide);
    chip.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(chip.dataset.chip ?? '');
      } catch {
        return; // no clipboard (an insecure page, a refused permission): nothing is said to have been copied
      }
      chip.setAttribute('data-copied', '');
      live.textContent = 'Copied';
      setTimeout(() => {
        chip.removeAttribute('data-copied');
        live.textContent = '';
      }, 1500);
    });
  }
  fitAll();
  document.fonts?.ready.then(fitAll);
  addEventListener('resize', () => {
    hide();
    fitAll();
  });
  // The site's language changed (src/scripts/lang-tabs.ts sets <html data-lang>): its chips now have a width
  new MutationObserver(fitAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-lang'] });
}
