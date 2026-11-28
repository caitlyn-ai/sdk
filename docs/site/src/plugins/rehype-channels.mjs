// The Beta label (scripts/docs-releases.mjs betaLabel): a link whose title starts "Beta:" ("New in 0.12.0-beta.1",
// to the install-a-beta commands) becomes the release channel's label, .caitlyn-channel (src/styles/components.css).
// The Markdown copies keep it as the ordinary link it is written as.
import { visit } from 'unist-util-visit';

export default function rehypeChannels() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'a' || !/^Beta:/.test(String(node.properties?.title ?? ''))) return;
      node.properties.className = [...(node.properties.className ?? []), 'caitlyn-channel'];
    });
  };
}
