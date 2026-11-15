// The landing page's index. On the page with a hero only (the landing page):
//   - a list whose items read "<title>: <description>" becomes a numbered index (class caitlyn-index): each item's
//     title and description are split into their own spans, so the title can sit above its description;
//   - the SDK table (Language | Package | Runs on) becomes cards (class caitlyn-sdk-cards).
// src/styles/components.css lays both out. The Markdown copies are untouched.
import { visit } from 'unist-util-visit';

const text = (node) => (node.type === 'text' ? node.value : (node.children ?? []).map(text).join(''));
const span = (className, children) => ({ type: 'element', tagName: 'span', properties: { className: [className] }, children });

/** Splits an item at its first ": " in top-level text into [title, description], or returns null. */
function split(li) {
  const kids = li.children.filter((c) => !(c.type === 'text' && !c.value.trim() && c === li.children[0]));
  const at = kids.findIndex((c) => c.type === 'text' && c.value.includes(': '));
  if (at < 0) return null;
  const node = kids[at];
  const cut = node.value.indexOf(': ');
  const before = node.value.slice(0, cut);
  const after = node.value.slice(cut + 2);
  const title = [...kids.slice(0, at), ...(before ? [{ type: 'text', value: before }] : [])];
  const description = [...(after ? [{ type: 'text', value: after.charAt(0).toUpperCase() + after.slice(1) }] : []), ...kids.slice(at + 1)];
  if (!title.length || !text({ children: title }).trim()) return null;
  return [title, description];
}

export default function rehypeLanding() {
  return (tree, file) => {
    if (!file.data?.astro?.frontmatter?.hero) return;
    visit(tree, 'element', (node) => {
      if (node.tagName === 'ul') {
        const items = node.children.filter((c) => c.type === 'element' && c.tagName === 'li');
        const parts = items.map(split);
        if (!items.length || parts.some((p) => !p)) return;
        node.properties.className = [...(node.properties.className ?? []), 'caitlyn-index'];
        items.forEach((li, i) => {
          li.children = [span('caitlyn-index-title', parts[i][0]), span('caitlyn-index-description', parts[i][1])];
        });
      }
      if (node.tagName === 'table') {
        const header = [];
        visit(node, 'element', (th) => {
          if (th.tagName === 'th') header.push(text(th).trim());
        });
        if (header.join('|') === 'Language|Package|Runs on') node.properties.className = [...(node.properties.className ?? []), 'caitlyn-sdk-cards'];
      }
    });
  };
}
