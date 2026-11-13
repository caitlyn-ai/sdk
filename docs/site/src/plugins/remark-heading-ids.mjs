// `{#id}` at the very end of a heading, after a space, is that heading's id; it is removed from the heading's
// text. Astro's rehypeHeadingIds then slugs (github-slugger, one slugger per page) only the headings with no id,
// so a heading with an explicit id does not take a turn with the slugger. caitlyn-data-ingestion computes
// citation anchors by the same rule (pdf/topic/document_citation.py), and test/heading-ids.test.mjs runs the
// fixture both repositories share. A paragraph or list item ending in `{#…}` keeps it as text.
import { visit } from 'unist-util-visit';

const EXPLICIT_ID = /[ \t]+\{#([^\s{}]+)\}[ \t]*$/;

export default function remarkHeadingIds() {
  return (tree) => {
    visit(tree, 'heading', (node) => {
      const last = node.children.at(-1);
      if (last?.type !== 'text') return;
      const m = EXPLICIT_ID.exec(last.value);
      if (!m) return;
      last.value = last.value.slice(0, m.index);
      if (!last.value) node.children.pop();
      node.data ??= {};
      node.data.hProperties = { ...node.data.hProperties, id: m[1] };
    });
  };
}
