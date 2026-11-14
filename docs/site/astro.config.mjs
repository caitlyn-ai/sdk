// The build.caitlyn.ai developer site. scripts/docs-build.mjs prepares src/content/docs/ (the hand-written pages
// in docs/ and the API reference generated from the model) and src/generated/sidebar.json, then runs
// `astro build`, which writes build/docs/site/. See docs/README.md.
import fs from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { unified } from '@astrojs/markdown-remark';
import remarkHeadingIds from './src/plugins/remark-heading-ids.mjs';
import remarkLangTabs from './src/plugins/remark-lang-tabs.mjs';

const sidebar = JSON.parse(fs.readFileSync(new URL('./src/generated/sidebar.json', import.meta.url), 'utf8'));

export default defineConfig({
  // scripts/docs-build.mjs sets these for a merge request's GitLab Pages preview, which is served under a path;
  // production is https://build.caitlyn.ai at the root.
  site: process.env.DOCS_SITE_ORIGIN ?? 'https://build.caitlyn.ai',
  base: process.env.DOCS_BASE ?? '/',
  // Directory pages with a trailing slash: /guides/x/ is guides/x/index.html, which the hosting serves for
  // /guides/x and /guides/x/, and the canonical address its Markdown copies' Link header names.
  trailingSlash: 'always',
  outDir: '../../build/docs/site',
  markdown: {
    processor: unified({
      remarkPlugins: [remarkHeadingIds, remarkLangTabs],
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
      customCss: ['./src/styles/caitlyn.css', './src/styles/custom.css'],
      expressiveCode: { styleOverrides: { borderRadius: '0px' } },
      components: { Footer: './src/components/Footer.astro', SiteTitle: './src/components/SiteTitle.astro' },
      sidebar,
      lastUpdated: false,
      pagination: false,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      head: [{ tag: 'meta', attrs: { name: 'robots', content: 'index, follow' } }],
    }),
  ],
});
