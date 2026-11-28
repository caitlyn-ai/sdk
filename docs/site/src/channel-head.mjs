// The script every page's head runs before it paints (astro.config.mjs): the release the page shows where the stable
// release and a beta differ (scripts/docs-releases.mjs channelSwitch), on <html data-channel>: the reader's last choice
// (src/scripts/channel-switch.ts remembers it), else the stable release. The stylesheet shows that side and presses its
// button from the first paint; once the page is parsed, each switch's aria-pressed says the same, whether or not the
// switch's own script loads. docs/site/test/sdk-releases.test.mjs runs it against a stand-in page.
export const CHANNEL_HEAD =
  "(()=>{let c='stable';try{if(localStorage.getItem('caitlyn-docs-channel')==='beta')c='beta'}catch{}const r=document.documentElement;r.dataset.channel=c;document.addEventListener('DOMContentLoaded',()=>{for(const b of document.querySelectorAll('[data-set-channel]'))b.setAttribute('aria-pressed',String(b.dataset.setChannel===r.dataset.channel))})})()";
