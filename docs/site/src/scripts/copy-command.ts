// A command a reader copies to use elsewhere, such as the Changelog's Slack `/feed subscribe` (scripts/docs-changelog.mjs
// FOLLOW): a button holding the command in the code face and a "Copy" label (src/styles/components.css
// .caitlyn-copy-command). Clicking it, or Enter or Space on it, copies its `data-copy`; the label reads "Copied" for a
// moment, and a screen reader hears it. With no clipboard (an insecure page, a refused permission) nothing claims a copy.

const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-copy]')];
if (buttons.length) {
  const live = document.createElement('p');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  document.body.append(live);
  for (const button of buttons) {
    const label = button.querySelector<HTMLElement>('.caitlyn-copy-command-label');
    let timer: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? '');
      } catch {
        return;
      }
      button.setAttribute('data-copied', '');
      if (label) label.textContent = 'Copied';
      live.textContent = 'Copied';
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.removeAttribute('data-copied');
        if (label) label.textContent = 'Copy';
        live.textContent = '';
      }, 1600);
    });
  }
}
