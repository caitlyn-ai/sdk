// The code panel's language menu (src/components/LanguageSelect.astro): a button and a listbox in the top layer (the
// Popover API, which also closes it on Escape or a click elsewhere), positioned under the button. Choosing a language
// dispatches `caitlyn-lang` with the key; src/scripts/lang-tabs.ts makes it the site's and calls `setPicker` on every
// menu. Keyboard: on the button, Enter, Space or the arrow keys open the list on the chosen language; in the list, the
// arrow keys, Home and End move, Enter or Space chooses, Escape and Tab close. Focus returns to the button on close.

const pickers = [...document.querySelectorAll<HTMLElement>('caitlyn-language-select')];

const options = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[role="option"]')];

/** Shows a language on a menu: the key when the menu offers it, TypeScript otherwise. Returns what it shows. */
export function setPicker(el: HTMLElement, key: string): string {
  const value = options(el).some((o) => o.dataset.value === key) ? key : 'typescript';
  el.dataset.value = value;
  for (const o of options(el)) o.setAttribute('aria-selected', String(o.dataset.value === value));
  return value;
}

for (const el of pickers) {
  const button = el.querySelector<HTMLButtonElement>('button')!;
  const list = el.querySelector<HTMLElement>('[role="listbox"]')!;
  const popover = 'showPopover' in list;
  if (!popover) list.removeAttribute('popover');
  let active = 0;

  const isOpen = () => (popover ? list.matches(':popover-open') : list.classList.contains('caitlyn-lang-list-open'));
  const mark = (i: number) => {
    const opts = options(el);
    active = (i + opts.length) % opts.length;
    opts.forEach((o, n) => o.classList.toggle('caitlyn-lang-option-active', n === active));
    list.setAttribute('aria-activedescendant', opts[active]!.id);
    opts[active]!.scrollIntoView({ block: 'nearest' });
  };
  const place = () => {
    const r = button.getBoundingClientRect();
    list.style.minWidth = `${Math.round(r.width)}px`;
    list.style.left = `${Math.round(Math.min(r.left, innerWidth - list.offsetWidth - 8))}px`;
    const below = r.bottom + 6 + list.offsetHeight <= innerHeight - 8;
    list.style.top = `${Math.round(below ? r.bottom + 6 : r.top - 6 - list.offsetHeight)}px`;
  };
  const open = () => {
    if (isOpen()) return;
    if (popover) list.showPopover();
    else list.classList.add('caitlyn-lang-list-open');
    place();
    button.setAttribute('aria-expanded', 'true');
    mark(Math.max(0, options(el).findIndex((o) => o.getAttribute('aria-selected') === 'true')));
    list.focus();
  };
  const close = (focusButton = true) => {
    if (popover && list.matches(':popover-open')) list.hidePopover();
    list.classList.remove('caitlyn-lang-list-open');
    button.setAttribute('aria-expanded', 'false');
    if (focusButton) button.focus();
  };
  const choose = (i: number) => {
    const key = options(el)[i]?.dataset.value;
    close();
    if (key) document.dispatchEvent(new CustomEvent('caitlyn-lang', { detail: key }));
  };

  button.addEventListener('click', () => (isOpen() ? close() : open()));
  button.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener('keydown', (e) => {
    const n = options(el).length;
    if (e.key === 'ArrowDown') mark(active + 1);
    else if (e.key === 'ArrowUp') mark(active - 1);
    else if (e.key === 'Home') mark(0);
    else if (e.key === 'End') mark(n - 1);
    else if (e.key === 'Enter' || e.key === ' ') choose(active);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') close(false);
    else return;
    e.preventDefault();
  });
  for (const [i, o] of options(el).entries()) {
    o.addEventListener('click', () => choose(i));
    o.addEventListener('mousemove', () => active !== i && mark(i));
  }
  // The popover closed itself (Escape, or a click elsewhere): keep the button's state in step, and give focus back
  // only when it was in the list
  list.addEventListener('toggle', (e) => {
    if ((e as ToggleEvent).newState !== 'closed') return;
    button.setAttribute('aria-expanded', 'false');
    if (list.contains(document.activeElement)) button.focus();
  });
  if (!popover) document.addEventListener('click', (e) => !el.contains(e.target as Node) && isOpen() && close(false));
  addEventListener('resize', () => isOpen() && close(false));
  addEventListener('scroll', () => isOpen() && place(), { capture: true, passive: true });
}
