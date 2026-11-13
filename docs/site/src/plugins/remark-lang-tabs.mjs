// Language tabs. A run of consecutive code blocks whose info strings carry `tab="<label>"` becomes one tab
// group, so the Markdown stays plain (the `.md` copies show the blocks one after another, each labelled):
//
//   ```ts tab="TypeScript"
//   ```python tab="Python"
//
// Every panel is in the HTML, so search indexes all of them and the page reads without script; the site's
// script (src/scripts/lang-tabs.ts) shows one at a time, remembers the reader's language, opens the tab the
// URL names (`?lang=python`) and the one holding a `:~:text=` target.
import { visit, SKIP } from 'unist-util-visit';

const TAB = /(?:^|\s)tab="([^"]+)"/;
export const langKey = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export default function remarkLangTabs() {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (!parent || index === undefined || node.type !== 'code' || !TAB.test(node.meta ?? '')) return;
      let end = index;
      while (parent.children[end]?.type === 'code' && TAB.test(parent.children[end].meta ?? '')) end++;
      const blocks = parent.children.slice(index, end);
      const tabs = blocks.map((b) => {
        const label = TAB.exec(b.meta)[1];
        b.meta = b.meta.replace(TAB, '').trim() || null;
        return { label, key: langKey(label), block: b };
      });
      const group = {
        type: 'langTabs',
        data: { hName: 'div', hProperties: { className: ['lang-tabs'], dataLangTabs: '' } },
        children: [
          {
            type: 'langTabList',
            data: { hName: 'div', hProperties: { className: ['lang-tab-list'], role: 'tablist', ariaLabel: 'Language' } },
            children: tabs.map((t) => ({
              type: 'langTab',
              data: { hName: 'button', hProperties: { type: 'button', role: 'tab', dataLang: t.key, className: ['lang-tab'] } },
              children: [{ type: 'text', value: t.label }],
            })),
          },
          ...tabs.map((t) => ({
            type: 'langPanel',
            data: { hName: 'div', hProperties: { className: ['lang-panel'], role: 'tabpanel', dataLang: t.key, dataLabel: t.label } },
            children: [t.block],
          })),
        ],
      };
      parent.children.splice(index, end - index, group);
      return [SKIP, index + 1];
    });
  };
}
