// The build.caitlyn.ai developer site. scripts/docs-build.mjs prepares src/content/docs/ (the hand-written pages
// in docs/ and the API reference generated from the model) and src/generated/sidebar.json, then runs
// `astro build`, which writes build/docs/site/. See docs/README.md.
import fs from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightSidebarTopics from 'starlight-sidebar-topics';
import starlightImageZoom from 'starlight-image-zoom';
import { unified } from '@astrojs/markdown-remark';
import remarkHeadingIds from './src/plugins/remark-heading-ids.mjs';
import remarkLangTabs from './src/plugins/remark-lang-tabs.mjs';
import rehypeTables from './src/plugins/rehype-tables.mjs';
import rehypeLead from './src/plugins/rehype-lead.mjs';
import rehypeLanding from './src/plugins/rehype-landing.mjs';
import { caitlynCodeTheme } from './src/code-theme.mjs';
import { isLive, robotsMeta } from '../../scripts/docs-sitemap.mjs';

// The site's sections, each with its own sidebar (starlight-sidebar-topics), as scripts/docs-build.mjs writes them
const topics = JSON.parse(fs.readFileSync(new URL('./src/generated/sidebar.json', import.meta.url), 'utf8'));
// The SDK reference moved from /reference/ to /sdk/; each old address is a page that sends the reader on
const redirects = JSON.parse(fs.readFileSync(new URL('./src/generated/redirects.json', import.meta.url), 'utf8'));

export default defineConfig({
  // Served at the root: build.caitlyn.ai, and each merge request's preview on its own host
  site: 'https://build.caitlyn.ai',
  // Directory pages with a trailing slash: /guides/x/ is guides/x/index.html, which the hosting serves for
  // /guides/x and /guides/x/, and the canonical address its Markdown copies' Link header names.
  trailingSlash: 'always',
  redirects,
  outDir: '../../build/docs/site',
  markdown: {
    processor: unified({
      remarkPlugins: [remarkHeadingIds, remarkLangTabs],
      rehypePlugins: [rehypeTables, rehypeLead, rehypeLanding],
      // Text stays as written: a `:~:text=` quote taken from the Markdown must match the page, so no curly
      // quotes or dashes are substituted.
      smartypants: false,
    }),
  },
  integrations: [
    starlight({
      title: 'Caitlyn developer docs',
      description: 'The Caitlyn v3 API and its SDKs.',
      // The approved Caitlyn lockup, as supplied by the design system (the PNGs, which share one tight crop): black
      // on light grounds, white on dark
      logo: {
        light: './src/assets/caitlyn-lockup-black.png',
        dark: './src/assets/caitlyn-lockup-white.png',
        alt: 'Caitlyn',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/caitlyn.css', './src/styles/custom.css', './src/styles/components.css', './src/generated/icons.css'],
      // Code sits on cover-ground in both themes, under a header bar with its language and a copy button
      // (src/styles/components.css), in monochrome (src/code-theme.mjs). Long lines wrap, keeping their indent,
      // so no example is cut off at the column's edge. Expressive Code raises any colour below 5.5:1.
      expressiveCode: {
        themes: [caitlynCodeTheme],
        defaultProps: { wrap: true, preserveIndent: true },
        useStarlightUiThemeColors: false,
        minSyntaxHighlightingColorContrast: 5.5,
        styleOverrides: {
          borderRadius: '12px', // --caitlyn-radius-code
          borderWidth: '0px', // one edge round the whole block instead (src/styles/components.css)
          borderColor: '#2e3331', // rule (dark)
          codeBackground: '#0a0c0b', // cover-ground
          codeForeground: '#ffffff', // cover-ink
          codeFontSize: 'var(--caitlyn-text-body)', // body, on the type scale (src/styles/caitlyn.css)
          codeLineHeight: '1.55', // body
          codePaddingBlock: '16px', // space-4
          codePaddingInline: '24px', // space-6
          uiFontFamily: "'Euclid Circular', Poppins, system-ui, sans-serif",
          uiFontSize: 'var(--caitlyn-text-kicker)', // kicker, on the type scale
          frames: {
            editorBackground: '#0a0c0b',
            editorTabBarBackground: '#0a0c0b',
            editorActiveTabBackground: '#0a0c0b',
            editorActiveTabForeground: '#ffffff',
            editorActiveTabIndicatorBottomColor: 'transparent',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorTabBarBorderBottomColor: '#2e3331',
            terminalBackground: '#0a0c0b',
            terminalTitlebarBackground: '#0a0c0b',
            terminalTitlebarForeground: '#a8b0ad',
            terminalTitlebarBorderBottomColor: '#2e3331',
            terminalTitlebarDotsOpacity: '0',
            frameBoxShadowCssValue: 'none',
            inlineButtonForeground: '#ffffff',
            inlineButtonBorder: '#a8b0ad',
            tooltipSuccessBackground: '#ffffff',
            tooltipSuccessForeground: '#0a0c0b',
          },
        },
      },
      components: {
        Footer: './src/components/Footer.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        Hero: './src/components/Hero.astro',
        Pagination: './src/components/Pagination.astro',
        PageTitle: './src/components/PageTitle.astro',
        PageSidebar: './src/components/PageSidebar.astro',
      },
      // starlight-image-zoom: a content screenshot opens full size, captioned with its alt text. Only images in a
      // page's Markdown zoom; the logo, the hero and the icons are not Markdown images. An image can opt out with
      // data-zoom-off.
      plugins: [starlightSidebarTopics(topics), starlightImageZoom({ showCaptions: true })],
      lastUpdated: false,
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      head: [
        // The site's code language (src/scripts/lang-tabs.ts) on <html> before the page paints: ?lang=, then the
        // reader's last choice, then TypeScript; curl is the API reference's, cli the CLI's
        {
          tag: 'script',
          content:
            "(()=>{const L=['typescript','python','go','rust','curl','cli'];let k=new URLSearchParams(location.search).get('lang');if(!L.includes(k)){try{k=localStorage.getItem('caitlyn-docs-lang')}catch{}}document.documentElement.dataset.lang=L.includes(k)?k:L[0]})()",
        },
        // Only the live build is indexed; a merge request's preview, or any build not marked live, carries noindex on
        // every page (scripts/docs-sitemap.mjs)
        { tag: 'meta', attrs: { name: 'robots', content: robotsMeta(isLive()) } },
        // The Changelog's Atom feed (scripts/docs-changelog.mjs), for a feed reader on any page
        { tag: 'link', attrs: { rel: 'alternate', type: 'application/atom+xml', title: 'Caitlyn SDK releases', href: '/changelog/feed.xml' } },
        // The two Euclid web fonts start downloading with the HTML rather than after the CSS is parsed. crossorigin
        // (anonymous) matches how @font-face fetches fonts, so the browser uses this one download.
        ...['EuclidCircularA-Regular-WebM.woff2', 'EuclidCircularB-Medium-WebS.woff2'].map((file) => ({
          tag: 'link',
          attrs: { rel: 'preload', href: `/_fonts/v1/${file}`, as: 'font', type: 'font/woff2', crossorigin: '' },
        })),
      ],
    }),
  ],
});
