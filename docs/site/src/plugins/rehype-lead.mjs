// The lead: an article's first paragraph, when it is short enough to read as one (at most 220 characters) and does
// not lead straight into a list (ending with a colon), gets class caitlyn-lead, which src/styles/components.css sets
// large above a strong rule. The landing page, whose first paragraph is in its hero, has none.
const text = (node) => (node.type === 'text' ? node.value : (node.children ?? []).map(text).join(''));
const MAX = 220;

export default function rehypeLead() {
  return (tree, file) => {
    if (file.data?.astro?.frontmatter?.hero) return;
    const first = tree.children.find((n) => n.type === 'element' || (n.type === 'text' && n.value.trim()));
    if (!first || first.type !== 'element' || first.tagName !== 'p') return;
    const t = text(first).trim();
    if (t.length > MAX || t.endsWith(':')) return;
    first.properties.className = [...(first.properties.className ?? []), 'caitlyn-lead'];
  };
}
