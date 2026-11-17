// Where the SDKs place each operation: the client as scopes (PROTOCOL.md 10), from conformance/cases/scope-tree.json,
// which model-support's ScopeTree writes for every generator (scripts/generate.sh). The docs' programs spell a call
// through it: `caitlyn.knowledge_bases("KB4T7YQ2WL").documents("doc-1").get()`, the identifiers in the scopes and the
// rest of the input as the call's arguments.
import fs from 'node:fs';
import path from 'node:path';
import { root } from './docs-model.mjs';

let tree;
let places;

function load() {
  if (places) return places;
  tree = JSON.parse(fs.readFileSync(path.join(root, 'conformance/cases/scope-tree.json'), 'utf8'));
  places = new Map();
  const walk = (node, chain) => {
    const here = [...chain, node];
    for (const m of node.methods ?? []) {
      if (!places.has(m.operation)) places.set(m.operation, []);
      places.get(m.operation).push({ chain: here, method: m, estimate: false });
      if (m.estimate) {
        if (!places.has(m.estimate)) places.set(m.estimate, []);
        places.get(m.estimate).push({ chain: here, method: m, estimate: true });
      }
    }
    // A scope followed through a filtered watch (a document, a folder, a batch on the knowledge base's watch) has its
    // own watch(): `kb.documents(id).watch()` is WatchKnowledgeBase with `document` filled from the scope.
    if (node.kind === 'scope' && node.watch?.filter && node.identifiers?.length) {
      const ids = node.identifiers;
      const fills = [
        ...ids.slice(0, -1).map((i) => ({ member: i.name, identifier: i.name })),
        { member: node.watch.filter, identifier: ids[ids.length - 1].name },
      ];
      if (!places.has(node.watch.watch)) places.set(node.watch.watch, []);
      places.get(node.watch.watch).push({ chain: here, method: { name: 'watch', operation: node.watch.watch, fills }, estimate: false });
    }
    for (const c of Object.values(node.children ?? {})) walk(c, here);
    if (node.scope) walk(node.scope, here);
  };
  walk(tree, []);
  return places;
}

/** The value an input gives a scope's identifier: through the member the method fills from it. */
function identifierValue(identifier, method, input) {
  const fill = (method.fills ?? []).find((f) => f.identifier === identifier && f.member in input);
  return fill ? input[fill.member] : input[identifier];
}

/** A named scope (agent.draft) fits an input only when the input names the same value. */
function fits({ chain, method }, input) {
  for (const node of chain) {
    for (const i of node.identifiers ?? []) {
      if (i.fixed === undefined) continue;
      const member = (method.fills ?? []).find((f) => f.identifier === i.name)?.member ?? i.name;
      if (member in input && input[member] !== i.fixed) return false;
    }
  }
  return true;
}

/**
 * An operation's place for an input: { steps, method, estimate, leading, filled }. `steps` are the client's nodes
 * below the root, each { name } for a property or { name, args, singular } for a collection called with identifiers; `leading`
 * the identifiers a building block takes first; `filled` the input members the scopes and leading arguments give.
 */
export function placement(operation, input) {
  const all = load().get(operation) ?? [];
  const fitting = all.filter((p) => fits(p, input));
  if (!fitting.length) throw new Error(`docs-scopes: ${operation} has no place in the scope tree`);
  const score = (p) => (p.method.fills ?? []).filter((f) => f.member in input).length;
  const best = fitting.reduce((a, b) => (score(b) > score(a) ? b : a));
  const steps = [];
  for (let n = 1; n < best.chain.length; n++) {
    const parent = best.chain[n - 1];
    const node = best.chain[n];
    if (node.kind === 'scope' && parent.kind === 'collection' && parent.scope === node) {
      steps[steps.length - 1].args = parent.identifiers.map((i) => identifierValue(i.name, best.method, input));
      // Go and Rust call a scope by the collection's singular (`knowledge_base(id)`) beside the plural.
      steps[steps.length - 1].singular = parent.singular;
    } else steps.push({ name: node.name });
  }
  return {
    steps,
    method: best.method,
    estimate: best.estimate,
    leading: (best.method.leading ?? []).map((i) => identifierValue(i, best.method, input)),
    filled: new Set((best.method.fills ?? []).map((f) => f.member)),
  };
}
