// Which SDK release has what. The site is built from main, but describes the latest stable release, the one a package
// manager installs, and marks what only a beta has. Two things are kept apart, never sharing a word or a style:
//
//   - an operation's stability (Preview, Experimental, GA: the model's @stability), which is its stability badge
//     (scripts/docs-reference.mjs STABILITY);
//   - the release channel: the Beta label, "New in 0.12.0-beta.1", on whatever no stable release has yet (betaLabel),
//     linking to the commands that install a beta. Both can sit together: "Preview · New in 0.12.0-beta.1".
//
// From the repository's own tags (vX.Y.Z, a stable release; vX.Y.Z-beta.N, a beta, the model:main job's):
//
//   - the generated reference compares the model at the latest stable tag with main's (apiChannels): an operation,
//     member or enum value main adds gets the Beta label, and a member main changes shows both forms with the stable
//     one first and a switch to the beta's (channelSwitch);
//   - a hand-written section that is new gets the label from a `<!-- sdk-release: <change file> -->` line under its
//     heading (fillSdkRelease), and one written two ways a `<!-- channel-toggle: <change file> -->` block
//     (fillChannelToggles), each going once a stable release has that change;
//   - the getting-started page's install commands show the newest beta's beside the stable ones (fillInstall), and
//     its Install a beta section has them all (fillInstallBeta);
//   - the Changelog's "In beta" row (scripts/docs-changelog.mjs) is the newest beta's notes;
//   - the CLI, until it has a stable release, carries the Beta label on every page, and until it has any release, a
//     callout saying so (cliRelease, from the channel pointers scripts/cli-channels.sh fetches).
//
// go/ tags are the Go module's copies and are ignored. A checkout without tags (a local worktree that never fetched
// them) has no stable release to compare with: nothing is labelled.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assemble, modelChanges } from './model-diff.mjs';
import { publicDoc } from './docs-model.mjs';

export const root = path.resolve(import.meta.dirname, '..');
const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;
const BETA = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;
// The getting-started section the Beta label links to
export const INSTALL_BETA = '/getting-started/#install-a-beta';
// The CLI's: its install page, with its channels
export const INSTALL_CLI = '/cli/install/';
// Releasing commits, as semantic-release reads them: their scope docs or ci changes nothing in the SDKs
const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?: /;
const RELEASING_TYPES = new Set(['feat', 'fix', 'perf', 'revert']);
const HIDDEN_SCOPES = new Set(['docs', 'ci']);

const git = (args, { cwd = root } = {}) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).replace(/\n$/, '');
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------------------------------------ tags

/** A tag as { tag, version, stable, beta (its number, or null) }, or null for any other tag. */
export function parseTag(tag) {
  const s = STABLE.exec(tag);
  if (s) return { tag, version: tag.slice(1), stable: true, beta: null, parts: [+s[1], +s[2], +s[3]] };
  const b = BETA.exec(tag);
  if (b) return { tag, version: tag.slice(1), stable: false, beta: +b[4], parts: [+b[1], +b[2], +b[3]] };
  return null;
}
/** Release order: by version, a beta before its stable release (0.12.0-beta.2 < 0.12.0). */
export function compareTags(a, b) {
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  if (a.stable !== b.stable) return a.stable ? 1 : -1;
  return (a.beta ?? 0) - (b.beta ?? 0);
}
/** The SDK's release and beta tags, oldest first. `names` is a test's tag list; by default the repository's. */
export function sdkTags(names = (git(['tag', '--list', 'v*']) ?? '').split('\n')) {
  return names.map(parseTag).filter(Boolean).sort(compareTags);
}

/**
 * The releases: { stable, beta, ahead }. `stable` is the newest stable version (null before the first); `beta` the
 * newest beta of a later version (null when the latest stable release is newer than every beta); `ahead` whether
 * main has more than the latest stable release: a beta of a later version, or a releasing commit since that release
 * (`releasingSince`, a test's answer).
 */
export function channels(tags = sdkTags(), { releasingSince = releasingCommitsSince } = {}) {
  const stable = tags.filter((t) => t.stable).at(-1) ?? null;
  const beta = tags.filter((t) => !t.stable && (!stable || compareTags(t, stable) > 0)).at(-1) ?? null;
  const ahead = !!beta || !!(stable && releasingSince(stable.tag));
  return { stable: stable?.version ?? null, beta: beta?.version ?? null, ahead };
}
/** Whether any commit since `tag` makes a release (feat, fix, perf, revert or `!`, outside the docs and ci scopes). */
function releasingCommitsSince(tag) {
  const subjects = git(['log', '--no-merges', '--format=%s', `${tag}..HEAD`]);
  return (subjects ?? '').split('\n').some(releasingSubject);
}
/** Whether a commit subject makes a release that changes the SDKs: a breaking change, or feat, fix, perf or revert outside the docs and ci scopes. */
export function releasingSubject(subject) {
  const m = HEADER.exec(subject);
  if (!m) return false;
  if (m[3]) return true;
  return RELEASING_TYPES.has(m[1]) && !HIDDEN_SCOPES.has(m[2]);
}

/** PyPI's spelling of a version: 0.12.0-beta.1 is 0.12.0b1. */
export const pep440 = (version) => version.replace(/-beta\./, 'b');

// ------------------------------------------------------------------------------------------------ arrivals

/**
 * Where something arrived, from the tags that have it (any order): { stable, beta }, the first stable release that
 * has it and, when none does, the first beta that does. Both null when no tag has it yet.
 */
export function arrival(having) {
  const sorted = [...having].sort(compareTags);
  const stable = sorted.find((t) => t.stable);
  if (stable) return { stable: stable.version, beta: null };
  return { stable: null, beta: sorted.find((t) => !t.stable)?.version ?? null };
}

/**
 * A change file's arrival in the SDKs (changes/<name>.md): the tags that contain the commit that added it, or the
 * commit its `commit:` front matter names. { stable: null, beta: null } when no tag has it yet, as for a change this
 * merge request adds; null when there is no such change file.
 */
export function changeArrival(name, { cwd = root } = {}) {
  const file = path.join(cwd, 'changes', `${name}.md`);
  if (!fs.existsSync(file)) return null;
  const named = /^commit:\s*([0-9a-f]{7,40})\s*$/m.exec(fs.readFileSync(file, 'utf8'))?.[1];
  const commit = named ?? git(['log', '--diff-filter=A', '--format=%H', '--', `changes/${name}.md`], { cwd })?.split('\n').filter(Boolean).at(-1);
  if (!commit) return { stable: null, beta: null };
  const tags = (git(['tag', '--list', 'v*', '--contains', commit], { cwd }) ?? '').split('\n').map(parseTag).filter(Boolean);
  return arrival(tags);
}

// ------------------------------------------------------------------------------------------------ the Beta label

// The release channel's label: accent-coloured, naming the beta something is new in, and linking to the commands that
// install a beta. It is a Markdown link whose title starts "Beta:", which docs/site/src/plugins/rehype-channels.mjs
// sets as the label on the site (.caitlyn-channel), so the Markdown copies keep it as an ordinary link.
export const BETA_TITLE = 'Beta: not in a stable release yet';
// The title of the note on what the betas dropped ("Removed in 0.12.0-beta.1")
export const REMOVED_TITLE = 'Beta: the betas no longer have it';
/** A Beta label in Markdown. */
export const BETA_LABEL = /\[[^\]]+\]\([^)\s]+ "Beta: [^"]*"\)/;

/**
 * The label's words for something no stable release has: "New in 0.12.0-beta.1", the first beta that has it; "New
 * since 0.11.0" when no beta has it yet (only main has it); "New" before any release. Null when a stable release has
 * it: the site describes that release, so it needs no label.
 */
export function betaWords(a, { stable = null } = {}) {
  if (a?.stable) return null;
  if (a?.beta) return `New in ${a.beta}`;
  return stable ? `New since ${stable}` : 'New';
}
/** The Beta label as Markdown, or '' when a stable release has it. `link` is where it goes: installing a beta. */
export function betaLabel(a, { stable = null, link = INSTALL_BETA } = {}) {
  const words = betaWords(a, { stable });
  return words ? `[${words}](${link} "${BETA_TITLE}")` : '';
}

/**
 * A hand-written page's `<!-- sdk-release: <change file> -->` lines, each under the heading of a section that is new:
 * the Beta label for the release that change file arrived in (changeArrival), or nothing once a stable release has
 * it. Returns { markdown, problems }: a line naming no change file is a problem, which fails the build.
 * `arrivalOf` is a test's lookup; `stable` the latest stable release, for a change no beta has yet.
 */
export const SDK_RELEASE_MARKER = /^<!-- sdk-release:\s*([a-z0-9][a-z0-9-]*)\s*-->$/;
export function fillSdkRelease(markdown, { arrivalOf = changeArrival, stable = null } = {}) {
  const problems = [];
  const out = markdown.replace(/^(<!-- sdk-release:\s*([^>]*?)\s*-->)\n(\n?)/gm, (whole, line, name, gap) => {
    const a = SDK_RELEASE_MARKER.test(line) ? arrivalOf(name) : null;
    if (!a) {
      problems.push(`${line}: names no change file (changes/${name}.md)`);
      return whole;
    }
    const label = betaLabel(a, { stable });
    return label ? `${label}\n${gap}` : '';
  });
  return { markdown: out, problems };
}

// ------------------------------------------------------------------------------------------------ stable or beta

// A rare thing that differs between the stable release and a beta (a member whose type changed, or a guide section
// written two ways) shows the stable form, with a switch to the beta's: "Stable 0.11.0 | Beta 0.12.0-beta.1". The
// switch sets the whole page and is remembered (docs/site/src/scripts/channel-switch.ts), and the stylesheet hides
// the other side ([data-channel-only], src/styles/components.css). The Markdown copies show both (plainChannels).

/** The switch's HTML. */
export const channelSwitch = ({ stable, beta }) =>
  `<span class="caitlyn-channel-switch" role="group" aria-label="Show the stable release or the beta"><button type="button" data-set-channel="stable" aria-pressed="true">Stable ${stable}</button><button type="button" data-set-channel="beta" aria-pressed="false">Beta ${beta}</button></span>`;
/** One side's inline HTML; the beta's names itself ("Beta 0.12.0-beta.1") for the Markdown copy. */
export const channelSpan = (side, html, name = null) => `<span data-channel-only="${side}"${name ? ` data-name="${name}"` : ''}>${html}</span>`;

/**
 * A hand-written page's toggle blocks, for a section the beta changes:
 *
 *   <!-- channel-toggle: <change file> -->
 *   <!-- stable -->
 *   … the section as the stable release has it …
 *   <!-- beta -->
 *   … the section as the beta has it …
 *   <!-- /channel-toggle -->
 *
 * While no stable release has the change, both sides with the switch, the stable side shown first; once a stable
 * release has it, the beta side alone. Returns { markdown, problems }.
 */
const TOGGLE = /^<!-- channel-toggle:\s*([a-z0-9][a-z0-9-]*)\s*-->\n<!-- stable -->\n([\s\S]*?)^<!-- beta -->\n([\s\S]*?)^<!-- \/channel-toggle -->\n?/gm;
export function fillChannelToggles(markdown, { arrivalOf = changeArrival, stable = null } = {}) {
  const problems = [];
  let matched = 0;
  const out = markdown.replace(TOGGLE, (block, name, was, now) => {
    matched++;
    const a = arrivalOf(name);
    if (!a) {
      problems.push(`<!-- channel-toggle: ${name} -->: names no change file (changes/${name}.md)`);
      return block;
    }
    if (a.stable || !stable) return now;
    return channelBlock({ stable, beta: a.beta ?? `since ${stable}` }, was, now);
  });
  if ((markdown.match(/^<!-- channel-toggle:/gm) ?? []).length > matched) problems.push('a <!-- channel-toggle --> block needs a <!-- stable --> part, a <!-- beta --> part and <!-- /channel-toggle -->');
  return { markdown: out, problems };
}
const channelBlock = (names, was, now) =>
  [`<div class="caitlyn-channels" data-stable="${names.stable}" data-beta="${names.beta}">`, '', channelSwitch(names), '', '<div data-channel-only="stable">', '', was.trim(), '', '</div>', '<div data-channel-only="beta">', '', now.trim(), '', '</div>', '</div>', ''].join('\n');

/**
 * A page's Markdown copy: a toggle block as both sides in turn, each under its name ("**Stable 0.11.0:**", "**Beta
 * 0.12.0-beta.1:**"), and an inline pair as "stable form (Beta 0.12.0-beta.1: beta form)".
 */
export function plainChannels(md) {
  return md
    .replace(
      /<div class="caitlyn-channels" data-stable="([^"]*)" data-beta="([^"]*)">\n\n<span class="caitlyn-channel-switch".*\n\n<div data-channel-only="stable">\n\n([\s\S]*?)\n\n<\/div>\n<div data-channel-only="beta">\n\n([\s\S]*?)\n\n<\/div>\n<\/div>/g,
      (_, stable, beta, was, now) => `**Stable ${stable}:**\n\n${was}\n\n**Beta ${beta}:**\n\n${now}`,
    )
    .replace(/<span class="caitlyn-channel-switch"[^>]*>(?:<button[^>]*>[^<]*<\/button>)+<\/span> ?/g, '')
    .replace(/<span data-channel-only="stable">(.*?)<\/span> ?<span data-channel-only="beta" data-name="([^"]*)">(.*?)<\/span>/g, '$1 ($2: $3)');
}

// ------------------------------------------------------------------------------------------------ the API, stable and beta

const local = (id) => id.split('#').pop();
/**
 * What the reference marks: the model at the latest stable tag against main's, through `diff` (scripts/model-diff.mjs
 * modelChanges, by default), each with the first beta that has it. Returns:
 *
 *   stable            the latest stable release's version
 *   stableModel       its model, assembled (mixins flattened), to show what it has that main does not
 *   operations        Map(name, arrival): the operations main adds
 *   members           Map("Shape$member", arrival): the members main adds
 *   changed           Map("Shape$member", { arrival, from, to }): the members main changes, `from` and `to` each
 *                     { target (a full shape id), required }, `from` read from the stable model
 *   enumValues        Map("Enum$value", arrival): the enum values main adds
 *   removedOperations Map(name, arrival): the operations main no longer has, arrival the first beta without it
 *   removedMembers    Map("Shape", [{ name, member, arrival }]): the members main drops, `member` the stable model's
 *   removedValues     Map("Enum", [{ value, doc, arrival }]): the enum values main drops
 *
 * Keys are shapes' local names, as the diff names them. `models` is a test's { stable, betas: [{ version, model }],
 * main }; by default the tags' models and the working tree's.
 */
export function apiChannels({ ch = channels(), models = null, diff = modelChanges } = {}) {
  const out = { stable: ch.stable, stableModel: null, operations: new Map(), members: new Map(), changed: new Map(), enumValues: new Map(), removedOperations: new Map(), removedMembers: new Map(), removedValues: new Map() };
  if (!ch.stable) return out;
  const m = models ?? defaultModels(ch);
  if (!m.stable || !m.main) return out;
  const stable = assemble(m.stable);
  const main = assemble(m.main);
  // The stable model's documentation as the public docs show it, as loadModel does for main's (scripts/docs-model.mjs)
  for (const shape of Object.values(stable)) {
    for (const traits of [shape.traits, ...Object.values(shape.members ?? {}).map((x) => x.traits)]) {
      if (traits?.['smithy.api#documentation']) traits['smithy.api#documentation'] = publicDoc(traits['smithy.api#documentation']);
    }
  }
  out.stableModel = { shapes: stable };
  // Shapes by their local name, in each model
  const ids = (shapes) => new Map(Object.keys(shapes).map((id) => [local(id), id]));
  const [stableIds, mainIds] = [ids(stable), ids(main)];
  const memberOf = (shapes, byName, shape, member) => shapes[byName.get(shape)]?.members?.[member] ?? null;
  // A change to a mixin shows on each structure that uses it, which is where the reference shows the member
  const mixins = new Set([stable, main].flatMap((x) => Object.entries(x).filter(([, s]) => s.traits?.['smithy.api#mixin']).map(([id]) => local(id))));
  const changesTo = (to) => diff(m.stable, to).filter((c) => !(c.shape && mixins.has(c.shape)));
  // A changed member is keyed by the form main has, so its label names the first beta with that form
  const key = (c) => `${c.kind}:${c.operation ?? c.shape ?? ''}$${c.member ?? c.value ?? ''}${c.kind === 'memberChanged' ? `>${c.to.target}:${c.to.required}` : ''}`;
  const firstBeta = new Map();
  for (const b of m.betas) for (const c of changesTo(b.model)) if (!firstBeta.has(key(c))) firstBeta.set(key(c), b.version);
  const push = (map, k, v) => (map.get(k) ?? map.set(k, []).get(k)).push(v);
  // What the stable release could not have shown: an experimental operation's, member's or value's, which only the
  // betas ever had, and an operation with no SDK method, which the SDK reference never documents
  const shown = (c) => c.surface !== 'experimental' && !(c.kind === 'operationRemoved' && (c.stability === 'experimental' || stable[stableIds.get(c.operation)]?.traits?.['ai.caitlyn.traits#noClientMethod']));
  for (const c of changesTo(m.main).filter((x) => !x.kind.endsWith('Removed') || shown(x))) {
    const a = { stable: null, beta: firstBeta.get(key(c)) ?? null };
    if (c.kind === 'operationAdded') out.operations.set(c.operation, a);
    else if (c.kind === 'operationRemoved') out.removedOperations.set(c.operation, a);
    else if (c.kind === 'memberAdded') out.members.set(`${c.shape}$${c.member}`, a);
    else if (c.kind === 'memberRemoved') push(out.removedMembers, c.shape, { name: c.member, member: memberOf(stable, stableIds, c.shape, c.member), arrival: a });
    else if (c.kind === 'memberChanged') {
      const was = memberOf(stable, stableIds, c.shape, c.member);
      const now = memberOf(main, mainIds, c.shape, c.member);
      out.changed.set(`${c.shape}$${c.member}`, { arrival: a, from: { target: was?.target ?? c.from.target, required: c.from.required }, to: { target: now?.target ?? c.to.target, required: c.to.required } });
    } else if (c.kind === 'enumValueAdded') out.enumValues.set(`${c.shape}$${c.value}`, a);
    else if (c.kind === 'enumValueRemoved') {
      const value = Object.entries(stable[stableIds.get(c.shape)]?.members ?? {}).find(([n, x]) => (x.traits?.['smithy.api#enumValue'] ?? n) === c.value)?.[1];
      push(out.removedValues, c.shape, { value: c.value, doc: value?.traits?.['smithy.api#documentation'] ?? '', arrival: a });
    }
  }
  return out;
}
function defaultModels(ch) {
  const read = (ref) => {
    const text = git(['show', `${ref}:model/model.json`]);
    return text ? JSON.parse(text) : null;
  };
  const stable = parseTag(`v${ch.stable}`);
  const betas = sdkTags()
    .filter((t) => !t.stable && compareTags(t, stable) > 0)
    .map((t) => ({ version: t.version, model: read(t.tag) }))
    .filter((b) => b.model);
  const main = JSON.parse(fs.readFileSync(path.join(root, 'model/model.json'), 'utf8'));
  return { stable: read(stable.tag), betas, main };
}

/** The words for something main no longer has: "Removed in 0.12.0-beta.1", or "Removed since 0.11.0" before a beta. */
export const removedWords = (a, { stable = null } = {}) => (a?.beta ? `Removed in ${a.beta}` : `Removed since ${stable ?? 'the stable release'}`);

// ------------------------------------------------------------------------------------------------ installing

/** Each language's stable install commands, and the beta's, as one tab per language. */
const INSTALL = [
  { tab: 'TypeScript', stable: ['npm install @caitlyn-ai/sdk'], beta: () => ['npm install @caitlyn-ai/sdk@beta'] },
  { tab: 'Python', stable: ['pip install caitlyn', '# or, in a uv project', 'uv add caitlyn'], beta: (v) => ['pip install --pre caitlyn', '# or, in a uv project', `uv add caitlyn==${pep440(v)}`] },
  { tab: 'Go', stable: ['go get github.com/caitlyn-ai/sdk/go@latest'], beta: (v) => [`go get github.com/caitlyn-ai/sdk/go@v${v}`] },
  { tab: 'Rust', stable: ['cargo add caitlyn-sdk', '# the examples run on tokio', 'cargo add tokio --features macros,rt-multi-thread'], beta: (v) => [`cargo add caitlyn-sdk@${v}`] },
];
const tabs = (lines) => INSTALL.flatMap((l) => [`\`\`\`sh tab="${l.tab}"`, ...lines(l), '```']).join('\n');

/** The install-a-beta commands for a beta version, one tab per language. */
export const betaCommands = (beta) => tabs((l) => l.beta(beta));
/** The one-line form, for the Changelog's "In beta" row. */
export const betaCommandsInline = (beta) => INSTALL.map((l) => `\`${l.beta(beta)[0]}\``).join(', ').replace(/, (?=[^,]*$)/, ' or ');

/**
 * The getting-started page's `<!-- install -->` line: each language's stable commands, and, while a beta is newer than
 * the latest stable release, the beta's beside them.
 */
export function fillInstall(markdown, ch = channels()) {
  return markdown.replace(/^<!-- install -->$/m, () => tabs((l) => [...l.stable, ...(ch.beta ? [`# the beta, ${ch.beta}`, ...l.beta(ch.beta).filter((x) => !x.startsWith('#'))] : [])]));
}

/**
 * The getting-started page's `<!-- install-beta -->` line: the newest beta's version, the commands that install it,
 * and how a beta is named on each registry; or, when no beta is newer than the latest stable release, a sentence
 * saying the stable commands above install the newest release.
 */
export function fillInstallBeta(markdown, ch = channels()) {
  return markdown.replace(/^<!-- install-beta -->$/m, () => {
    if (!ch.beta) return `No beta is newer than the latest stable release${ch.stable ? `, ${ch.stable}` : ''}: the commands above install it.`;
    return [`The newest beta is ${ch.beta}: \`${pep440(ch.beta)}\` on PyPI, \`${ch.beta}\` on npm (its \`beta\` tag) and crates.io, and \`v${ch.beta}\` for Go.`, '', betaCommands(ch.beta)].join('\n');
  });
}

// ------------------------------------------------------------------------------------------------ the CLI

/** The CLI's channel pointers the build fetched (scripts/cli-channels.sh): { stable, beta } versions, or null when none exists yet. */
export function cliRelease(file = path.join(root, 'build/cli-channels.json')) {
  if (process.env.DOCS_CLI_RELEASE) return JSON.parse(process.env.DOCS_CLI_RELEASE);
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return c.stable || c.beta ? { stable: c.stable ?? null, beta: c.beta ?? null } : null;
  } catch {
    return null;
  }
}
/** Until the CLI has any release, the callout under its Beta label (and in the getting-started CLI section). */
export const CLI_CALLOUT = '> **No release yet.** There is no CLI release to install yet.';
/**
 * Until the CLI has a stable release, what every CLI page carries after its lead: the Beta label (the CLI beta's
 * version, else the SDK beta the CLI arrived in), and, until it has any release, the callout. Null once it has a
 * stable release. `arrived` is the CLI's change file's arrival (changeArrival('the-caitlyn-cli')).
 */
export function cliNotice(release = cliRelease(), { arrived = null, stable = null } = {}) {
  if (release?.stable) return null;
  const label = betaLabel(release?.beta ? { stable: null, beta: release.beta } : { stable: null, beta: arrived?.beta ?? null }, { stable, link: INSTALL_CLI });
  return release ? label : `${label}\n\n${CLI_CALLOUT}`;
}
/** A CLI page's body with the notice: after its first paragraph when that is prose (so it stays the lead), else first. */
export function withCliNotice(body, notice) {
  if (!notice) return body;
  const at = body.indexOf('\n\n');
  const lead = at > 0 ? body.slice(0, at) : '';
  if (!lead.trim() || /^(#|>|\||```|-|\*|\d+\.|<)/.test(lead.trim())) return `${notice}\n\n${body}`;
  return `${lead}\n\n${notice}\n\n${body.slice(at + 2)}`;
}
/** The `<!-- cli-release -->` line: the callout while there is no CLI release, else nothing. */
export const fillCliRelease = (markdown, release = cliRelease()) => markdown.replace(/^<!-- cli-release -->\n(\n?)/gm, (_, gap) => (release ? '' : `${CLI_CALLOUT}\n${gap}`));
/** The CLI's version and minor line for the install examples ({{cliVersion}}, {{cliMinor}}): its stable release's, or placeholders. */
export function cliVersions(release = cliRelease()) {
  const v = release?.stable ?? null;
  return { version: v ?? 'X.Y.Z', minor: v ? v.split('.').slice(0, 2).join('.') : 'X.Y' };
}
