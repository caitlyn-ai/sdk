// The stable-or-beta switch (scripts/docs-releases.mjs channelSwitch): "Stable 0.11.0 | Beta 0.12.0-beta.1" beside a
// member whose type a beta changed, or above a section written both ways. The page shows the stable release unless
// the reader picks the beta; the choice is on <html data-channel> (set before the page paints, astro.config.mjs) and
// remembered, and every switch on the page follows it. The stylesheet hides the other side ([data-channel-only]).

const KEY = 'caitlyn-docs-channel';
const root = document.documentElement;

const show = (channel: string) => {
  root.dataset.channel = channel === 'beta' ? 'beta' : 'stable';
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-set-channel]')) b.setAttribute('aria-pressed', String(b.dataset.setChannel === root.dataset.channel));
};

show(root.dataset.channel ?? 'stable');
document.addEventListener('click', (e) => {
  const button = (e.target as Element | null)?.closest<HTMLButtonElement>('[data-set-channel]');
  if (!button) return;
  show(button.dataset.setChannel ?? 'stable');
  try {
    localStorage.setItem(KEY, root.dataset.channel ?? 'stable');
  } catch {
    // Storage refused (a private window): the choice lasts for this page
  }
});
