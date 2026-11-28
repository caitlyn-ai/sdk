// Stability and the release channel, kept apart (scripts/docs-releases.mjs). The site describes the latest stable
// release: what only a beta has carries the Beta label ("New in 0.12.0-beta.1"), a member a beta changes shows its
// stable form with a switch to the beta's, and an operation's stability is its own badge (Preview, Experimental, none at
// GA). Also: the install commands, the Changelog's In beta row (and no feed entry for it), and the CLI's notice. Tags,
// models and the CLI's channels are given here, so the tests pass in any checkout. Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  BETA_LABEL,
  BETA_TITLE,
  REMOVED_TITLE,
  CLI_CALLOUT,
  INSTALL_BETA,
  INSTALL_CLI,
  apiChannels,
  arrival,
  betaCommands,
  betaLabel,
  betaWords,
  channels,
  cliNotice,
  cliVersions,
  compareTags,
  fillChannelToggles,
  fillCliRelease,
  fillInstall,
  fillInstallBeta,
  fillSdkRelease,
  parseTag,
  pep440,
  plainChannels,
  releasingSubject,
  sdkTags,
  withCliNotice,
} from '../../../scripts/docs-releases.mjs';
import { apiSections, atomFeed, changelogPage, parseChangelog } from '../../../scripts/docs-changelog.mjs';
import { modelChanges } from '../../../scripts/model-diff.mjs';
import { loadModel, operations, root } from '../../../scripts/docs-model.mjs';
import { referencePages } from '../../../scripts/docs-reference.mjs';
import { lineProblems } from '../../../scripts/docs-wording.mjs';
import rehypeChannels from '../src/plugins/rehype-channels.mjs';

const TAGS = ['v0.10.1', 'v0.11.0', 'v0.12.0-beta.2', 'v0.12.0-beta.1', 'go/v0.11.0', 'v0.9.0', 'latest'];
const CH = { stable: '0.11.0', beta: '0.12.0-beta.2', ahead: true };

test('tags: stable and beta tags in release order, a beta before its stable release, other tags ignored', () => {
  assert.deepEqual(sdkTags(TAGS).map((t) => t.version), ['0.9.0', '0.10.1', '0.11.0', '0.12.0-beta.1', '0.12.0-beta.2']);
  assert.ok(compareTags(parseTag('v0.12.0-beta.9'), parseTag('v0.12.0')) < 0);
  assert.equal(parseTag('go/v0.11.0'), null);
  assert.equal(pep440('0.12.0-beta.3'), '0.12.0b3');
});

test('channels: the latest stable release, and the newest beta of a later version', () => {
  assert.deepEqual(channels(sdkTags(TAGS), { releasingSince: () => false }), CH);
  assert.deepEqual(channels(sdkTags([...TAGS, 'v0.12.0']), { releasingSince: () => false }), { stable: '0.12.0', beta: null, ahead: false });
  assert.ok(releasingSubject('fix: a call you cancel ends cancelled'));
  assert.ok(!releasingSubject('fix(docs): the API changelog keeps an entry only for a release that changed the API'));
  assert.ok(releasingSubject('ci!: something breaking'));
});

test('the Beta label: the beta something is new in, linking to installing a beta, and nothing once a stable release has it', () => {
  assert.equal(betaWords({ stable: null, beta: '0.12.0-beta.1' }), 'New in 0.12.0-beta.1');
  assert.equal(betaWords({ stable: null, beta: null }, { stable: '0.11.0' }), 'New since 0.11.0');
  assert.equal(betaWords({ stable: '0.12.0', beta: null }), null);
  const label = betaLabel({ stable: null, beta: '0.12.0-beta.1' });
  assert.equal(label, `[New in 0.12.0-beta.1](${INSTALL_BETA} "Beta: not in a stable release yet")`);
  assert.ok(BETA_LABEL.test(label));
  assert.equal(betaLabel({ stable: '0.12.0', beta: null }), '');
  assert.deepEqual(lineProblems(label), []);
  assert.deepEqual(arrival(sdkTags(['v0.12.0', 'v0.12.0-beta.1'])), { stable: '0.12.0', beta: null });
});

test('the site sets the Beta label as .caitlyn-channel; any other link is left as it is', () => {
  const a = (title) => ({ type: 'element', tagName: 'a', properties: { href: '/x/', ...(title ? { title } : {}) }, children: [] });
  const tree = { type: 'root', children: [a('Beta: not in a stable release yet'), a('Errors'), a(null)] };
  rehypeChannels()(tree);
  assert.deepEqual(tree.children.map((n) => n.properties.className ?? null), [['caitlyn-channel'], null, null]);
});

// The API, stable against main: a fixture diff stands in for scripts/model-diff.mjs
const DIFF = (changes) => (stable, to) => changes[to.name] ?? [];
const MODELS = { stable: { name: 'stable', shapes: {} }, betas: [{ version: '0.12.0-beta.1', model: { name: 'b1', shapes: {} } }, { version: '0.12.0-beta.2', model: { name: 'b2', shapes: {} } }], main: { name: 'main', shapes: {} } };
const ADDED = { kind: 'memberAdded', shape: 'PublishAgentVersionInput', member: 'idempotencyKey', target: 'IdempotencyKey', required: false };
const CHANGED = { kind: 'memberChanged', shape: 'UpdateAgentInput', member: 'ifMatch', from: { target: 'smithy.api#Integer', required: false }, to: { target: 'smithy.api#String', required: true } };
const NEW_OP = { kind: 'operationAdded', operation: 'GetDocument' };

test('apiChannels: what main adds or changes against the stable release, each with the first beta that has it', () => {
  const c = apiChannels({ ch: CH, models: MODELS, diff: DIFF({ b1: [ADDED], b2: [ADDED, CHANGED], main: [ADDED, CHANGED, NEW_OP, { kind: 'enumValueAdded', shape: 'ReadersKind', value: 'everyone' }] }) });
  assert.deepEqual(c.members.get('PublishAgentVersionInput$idempotencyKey'), { stable: null, beta: '0.12.0-beta.1' });
  assert.equal(c.changed.get('UpdateAgentInput$ifMatch').arrival.beta, '0.12.0-beta.2');
  assert.deepEqual(c.operations.get('GetDocument'), { stable: null, beta: null });
  assert.deepEqual(c.enumValues.get('ReadersKind$everyone'), { stable: null, beta: null });
  // No stable release: nothing to compare with, nothing marked
  assert.equal(apiChannels({ ch: { stable: null, beta: '0.1.0-beta.1' }, models: MODELS, diff: DIFF({ main: [ADDED] }) }).members.size, 0);
});

test('the reference: Preview and the Beta label are separate, side by side; a new member is labelled; a changed one has the switch', () => {
  const ast = loadModel();
  ast.channels = apiChannels({ ch: CH, models: MODELS, diff: DIFF({ b1: [ADDED, NEW_OP], b2: [CHANGED], main: [ADDED, CHANGED, NEW_OP] }) });
  const { pages } = referencePages(ast, { unreleased: new Set(), next: null });
  const page = (name) => pages.find((p) => p.operation?.name === name);
  // A new operation: its stability badge and the Beta label, never the same word
  const op = page('GetDocument');
  assert.equal(op.operation.stability, 'preview');
  assert.deepEqual(op.operation.channel, { text: 'New in 0.12.0-beta.1', link: INSTALL_BETA, title: BETA_TITLE });
  assert.match(op.body, /^\| Stability \| Preview: Public, and may still change before it is generally available \|$/m);
  assert.match(op.body, /^\[New in 0\.12\.0-beta\.1\]\(\/getting-started\/#install-a-beta "Beta: not in a stable release yet"\)$/m);
  assert.doesNotMatch(op.siteBody ?? '', /^\[New in/m, 'the site shows the label in the header, not in the body');
  // An operation the stable release has: Preview, no Beta label
  assert.equal(page('ListDocuments').operation.channel, undefined);
  assert.doesNotMatch(page('ListDocuments').body, /"Beta:/);
  // A new member: the label in the Markdown table and in the site's row
  const publish = page('PublishAgentVersion');
  assert.match(publish.body, /\| `idempotencyKey` \[New in 0\.12\.0-beta\.1\]\(/);
  assert.match(publish.siteBody, /caitlyn-param-name">`idempotencyKey`<\/span> .*`Idempotency-Key`<\/span> \[New in 0\.12\.0-beta\.1\]\(/);
  // A changed member: the stable form, then the beta's; on the site, both with the switch, the stable one shown
  const update = page('UpdateAgent');
  assert.match(update.body, /\| `ifMatch` \| integer \(beta 0\.12\.0-beta\.2: string, required\) \|/);
  assert.match(update.siteBody, /data-set-channel="stable" aria-pressed="true">Stable 0\.11\.0<\/button><button type="button" data-set-channel="beta" aria-pressed="false">Beta 0\.12\.0-beta\.2<\/button>/);
  assert.match(update.siteBody, /<span data-channel-only="stable">integer<\/span><span data-channel-only="beta" data-name="Beta 0\.12\.0-beta\.2">string · required<\/span>/);
});

test('stability: the model\'s beta is Preview, experimental its own badge, GA none; an experimental operation is only in the betas', () => {
  const ast = loadModel();
  const id = Object.keys(ast.shapes).find((k) => k.endsWith('#GetDocument'));
  ast.shapes[id].traits['ai.caitlyn.traits#stability'] = 'experimental';
  const other = Object.keys(ast.shapes).find((k) => k.endsWith('#ListDocuments'));
  ast.shapes[other].traits['ai.caitlyn.traits#stability'] = 'ga';
  assert.equal(operations(ast).find((o) => o.name === 'ListFolders').stability, 'preview');
  const { pages } = referencePages(ast, { unreleased: new Set(), next: null });
  const exp = pages.find((p) => p.operation?.name === 'GetDocument');
  assert.equal(exp.operation.stability, 'experimental');
  assert.deepEqual(exp.operation.channel, { text: 'In the SDK betas only', link: INSTALL_BETA, title: BETA_TITLE });
  assert.match(exp.body, /^\| Stability \| Experimental: /m);
  const ga = pages.find((p) => p.operation?.name === 'ListDocuments');
  assert.match(ga.body, /^\| Stability \| Generally available \|$/m);
  assert.doesNotMatch(ga.siteBody, /data-stability="ga"/);
});

test('a hand-written section: <!-- sdk-release --> is the Beta label until a stable release has it, and a wrong name fails', () => {
  const arrivals = { 'name-your-application': { stable: null, beta: '0.12.0-beta.1' }, 'list-pages': { stable: '0.11.0', beta: null }, 'on-main': { stable: null, beta: null } };
  const arrivalOf = (n) => arrivals[n] ?? null;
  const { markdown, problems } = fillSdkRelease('## Name your application\n\n<!-- sdk-release: name-your-application -->\n\nText.\n\n## Pages\n\n<!-- sdk-release: list-pages -->\n\nMore.\n\n## Soon\n\n<!-- sdk-release: on-main -->\n', { arrivalOf, stable: '0.11.0' });
  assert.deepEqual(problems, []);
  assert.match(markdown, /^## Name your application\n\n\[New in 0\.12\.0-beta\.1\]\(\/getting-started\/#install-a-beta "Beta: not in a stable release yet"\)\n\nText\./m);
  assert.match(markdown, /^## Pages\n\nMore\./m);
  assert.match(markdown, /\[New since 0\.11\.0\]/);
  assert.equal(fillSdkRelease('<!-- sdk-release: no-such-change -->\n', { arrivalOf: () => null }).problems.length, 1);
});

const TOGGLE = '## Sign in\n\n<!-- channel-toggle: new-sign-in -->\n<!-- stable -->\nSign in with a token.\n<!-- beta -->\nSign in with a workload.\n<!-- /channel-toggle -->\n\n## Next\n';
test('a section written both ways: the stable side first with the switch, the beta side once a stable release has it', () => {
  const beta = fillChannelToggles(TOGGLE, { arrivalOf: () => ({ stable: null, beta: '0.12.0-beta.1' }), stable: '0.11.0' });
  assert.deepEqual(beta.problems, []);
  assert.match(beta.markdown, /<span class="caitlyn-channel-switch"[^>]*><button type="button" data-set-channel="stable" aria-pressed="true">Stable 0\.11\.0<\/button><button type="button" data-set-channel="beta" aria-pressed="false">Beta 0\.12\.0-beta\.1<\/button><\/span>/);
  assert.match(beta.markdown, /<div data-channel-only="stable">\n\nSign in with a token\.\n\n<\/div>\n<div data-channel-only="beta">\n\nSign in with a workload\.\n\n<\/div>/);
  // The Markdown copy has both, each under its name, and no switch
  assert.equal(plainChannels(beta.markdown), '## Sign in\n\n**Stable 0.11.0:**\n\nSign in with a token.\n\n**Beta 0.12.0-beta.1:**\n\nSign in with a workload.\n\n## Next\n');
  const released = fillChannelToggles(TOGGLE, { arrivalOf: () => ({ stable: '0.12.0', beta: null }), stable: '0.12.0' });
  assert.equal(released.markdown, '## Sign in\n\nSign in with a workload.\n\n## Next\n');
  assert.equal(fillChannelToggles(TOGGLE, { arrivalOf: () => null }).problems.length, 1);
  assert.equal(fillChannelToggles('<!-- channel-toggle: x -->\nno parts\n', { arrivalOf: () => ({ stable: null, beta: null }), stable: '0.11.0' }).problems.length, 1);
});

test('install: each language\'s stable command, the beta\'s beside it, and the Install a beta section', () => {
  const md = fillInstall('<!-- install -->', CH);
  assert.equal((md.match(/^```sh tab="/gm) ?? []).length, 4);
  for (const line of ['npm install @caitlyn-ai/sdk\n# the beta, 0.12.0-beta.2\nnpm install @caitlyn-ai/sdk@beta', 'pip install caitlyn', 'pip install --pre caitlyn', 'uv add caitlyn==0.12.0b2', 'go get github.com/caitlyn-ai/sdk/go@latest\n# the beta, 0.12.0-beta.2\ngo get github.com/caitlyn-ai/sdk/go@v0.12.0-beta.2', 'cargo add caitlyn-sdk@0.12.0-beta.2']) assert.ok(md.includes(line), line);
  assert.doesNotMatch(fillInstall('<!-- install -->', { stable: '0.12.0', beta: null }), /beta/);
  const beta = fillInstallBeta('<!-- install-beta -->', CH);
  assert.match(beta, /^The newest beta is 0\.12\.0-beta\.2: `0\.12\.0b2` on PyPI/);
  assert.equal((betaCommands('0.12.0-beta.2').match(/^```sh tab="/gm) ?? []).length, 4);
  assert.match(fillInstallBeta('<!-- install-beta -->', { stable: '0.12.0', beta: null }), /^No beta is newer than the latest stable release, 0\.12\.0/);
});

const NOTES = `# [0.12.0-beta.1](https://github.com/caitlyn-ai/sdk/compare/v0.11.0...v0.12.0-beta.1) (2026-11-28)


### Bug Fixes

* a call you cancel ends cancelled in every SDK ([db4f870](https://github.com/caitlyn-ai/sdk/commit/db4f8705aa))
`;
const STABLE = `# [0.11.0](https://github.com/caitlyn-ai/sdk/compare/v0.10.1...v0.11.0) (2026-11-20)


### Features

* one page of any list, and its pages, in every SDK ([0c580a7](https://github.com/caitlyn-ai/sdk/commit/0c580a75b2))
`;

test('the Changelog opens with one In beta row, with the install commands, and the feed has no entry for it', () => {
  const [beta] = parseChangelog(NOTES);
  assert.ok(beta.beta);
  const releases = [beta, ...parseChangelog(STABLE)];
  const { body, siteBody } = changelogPage(releases, []);
  assert.match(body, /^## In beta: 0\.12\.0-beta\.1 \{#v0-12-0-beta-1\}$/m);
  assert.ok(body.indexOf('In beta: 0.12.0-beta.1') < body.indexOf('## 0.11.0'));
  assert.match(body, /SDK beta, 28 November 2026\. A beta, not a stable release: every change since 0\.11\.0 so far\./);
  assert.ok(body.includes('`npm install @caitlyn-ai/sdk@beta`') && body.includes('`cargo add caitlyn-sdk@0.12.0-beta.1`'));
  assert.match(siteBody, /<section class="caitlyn-release" data-kind="beta">/);
  for (const l of body.split('\n')) assert.deepEqual(lineProblems(l), [], l);
  const feed = atomFeed(releases, [], { base: 'https://build.caitlyn.ai' });
  assert.doesNotMatch(feed, /beta/i);
  assert.match(feed, /<id>https:\/\/build\.caitlyn\.ai\/changelog\/#v0-11-0<\/id>/);
});

test('the CLI: the Beta label on every page until a stable CLI release, and the callout until any release', () => {
  const arrived = { stable: null, beta: '0.12.0-beta.1' };
  const none = cliNotice(null, { arrived, stable: '0.11.0' });
  assert.equal(none, `[New in 0.12.0-beta.1](${INSTALL_CLI} "Beta: not in a stable release yet")\n\n${CLI_CALLOUT}`);
  assert.equal(cliNotice({ stable: null, beta: '0.12.0-beta.3' }, { arrived }), `[New in 0.12.0-beta.3](${INSTALL_CLI} "Beta: not in a stable release yet")`);
  assert.equal(cliNotice({ stable: '0.12.0', beta: null }, { arrived }), null);
  const page = '`caitlyn` is Caitlyn on the command line.\n\n## Install\n';
  assert.ok(withCliNotice(page, none).startsWith(`\`caitlyn\` is Caitlyn on the command line.\n\n${none}\n\n## Install`));
  assert.ok(withCliNotice('## Install\n\nSteps.\n', none).startsWith(none));
  assert.equal(withCliNotice(page, null), page);
  const section = '## Install the CLI\n\nIntro.\n\n<!-- cli-release -->\n\n```sh\n```\n';
  assert.ok(fillCliRelease(section, null).includes(`${CLI_CALLOUT}\n\n\`\`\`sh`));
  assert.equal(fillCliRelease(section, { stable: '0.12.0', beta: null }), '## Install the CLI\n\nIntro.\n\n```sh\n```\n');
  assert.deepEqual(cliVersions({ stable: '0.12.4', beta: null }), { version: '0.12.4', minor: '0.12' });
  assert.deepEqual(cliVersions(null), { version: 'X.Y.Z', minor: 'X.Y' });
  for (const l of none.split('\n')) assert.deepEqual(lineProblems(l), []);
});

// The reference fed the real diff (scripts/model-diff.mjs modelChanges), whose changes name shapes by their local
// names: a stable model made from main's, with a member of another type (a shape main does not have), a member and an
// enum value main drops, an operation main adds and one it drops
test('the reference from the real diff: changed, removed and added members, values and operations, against a stable model', () => {
  const main = JSON.parse(fs.readFileSync(path.join(root, 'model/model.json'), 'utf8'));
  const stable = structuredClone(main);
  const S = stable.shapes;
  S['ai.caitlyn.v3#LegacyTag'] = { type: 'string', traits: { 'smithy.api#length': { min: 1, max: 64 } } };
  S['ai.caitlyn.v3#UpdateAgentInput'].members.ifMatch = { ...S['ai.caitlyn.v3#UpdateAgentInput'].members.ifMatch, target: 'ai.caitlyn.v3#LegacyTag' };
  S['ai.caitlyn.v3#UpdateAgentInput'].members.legacyNote = { target: 'smithy.api#String', traits: { 'smithy.api#documentation': 'A note the stable release still takes.' } };
  S['ai.caitlyn.v3#ReadersKind'].members.LEGACY = { target: 'smithy.api#Unit', traits: { 'smithy.api#enumValue': 'legacy', 'smithy.api#documentation': 'The old way.' } };
  // ListVoices is new in main; ListLegacyVoices only the stable release has
  S['ai.caitlyn.v3#ListLegacyVoices'] = structuredClone(S['ai.caitlyn.v3#ListVoices']);
  S['ai.caitlyn.v3#ListLegacyVoices'].traits['ai.caitlyn.traits#clientMethod'] = { namespace: 'agents.options', name: 'legacyVoices' };
  S['ai.caitlyn.v3#ListLegacyVoices'].traits['smithy.api#http'] = { ...S['ai.caitlyn.v3#ListVoices'].traits['smithy.api#http'], uri: '/v3/legacy-voices' };
  const service = S['ai.caitlyn.v3#Caitlyn'];
  service.operations = [...service.operations.filter((o) => o.target !== 'ai.caitlyn.v3#ListVoices'), { target: 'ai.caitlyn.v3#ListLegacyVoices' }];

  const changes = modelChanges(stable, main);
  assert.ok(changes.some((c) => c.kind === 'memberChanged' && c.from.target === 'LegacyTag'), 'the real diff names the shape by its local name');
  const ast = loadModel();
  ast.channels = apiChannels({ ch: { stable: '0.11.0', beta: '0.12.0-beta.1' }, models: { stable, betas: [{ version: '0.12.0-beta.1', model: main }], main } });
  assert.deepEqual(ast.channels.changed.get('UpdateAgentInput$ifMatch').from, { target: 'ai.caitlyn.v3#LegacyTag', required: true });
  assert.equal(ast.channels.changed.get('UpdateAgentInput$ifMatch').to.target, 'ai.caitlyn.v3#EntityTagCondition');

  const { pages } = referencePages(ast, { unreleased: new Set(), next: null });
  const page = (name) => pages.find((p) => p.operation?.name === name);
  const update = page('UpdateAgent');
  // The changed member: the stable form, read from the stable model (LegacyTag, a string, which main does not have),
  // then the beta's
  assert.match(update.body, /^\| `ifMatch` \| string \(required\) \(beta 0\.12\.0-beta\.1: string, required\) \|/m);
  assert.match(update.siteBody, /<span data-channel-only="stable">string · required<\/span><span data-channel-only="beta" data-name="Beta 0\.12\.0-beta\.1">string · required<\/span>/);
  // The removed member: on the stable side as the stable release has it, a note on the beta's
  assert.match(update.body, /^\| `legacyNote` \(removed in 0\.12\.0-beta\.1\) \| string \| body \| A note the stable release still takes\. \|$/m);
  assert.match(update.siteBody, /<div data-channel-only="stable">\n\n<div class="caitlyn-param">\n\n<span class="caitlyn-param-name">`legacyNote`<\/span>/);
  assert.match(update.siteBody, /<div data-channel-only="beta">\n\n<div class="caitlyn-param">\n\n<span class="caitlyn-param-name">`legacyNote`<\/span>\n\n<span class="caitlyn-param-meta"><span class="caitlyn-channel-switch"[^\n]*Removed in 0\.12\.0-beta\.1<\/span>/);
  // The removed enum value, on its type's page
  const readers = pages.find((p) => p.slug === 'reference/types/readers-kind');
  assert.match(readers.body, /^\| `legacy` \(removed in 0\.12\.0-beta\.1\) \| The old way\. \|$/m);
  assert.match(readers.siteBody, /`legacy`<\/span>\n\n<span class="caitlyn-param-meta"><span class="caitlyn-channel-switch"/);
  // The operation main adds has the Beta label; the one it drops keeps its page, saying so
  assert.deepEqual(page('ListVoices').operation.channel, { text: 'New in 0.12.0-beta.1', link: INSTALL_BETA, title: BETA_TITLE });
  const gone = pages.find((p) => p.removed);
  assert.equal(gone?.subtitle, 'ListLegacyVoices');
  assert.equal(gone.slug, 'reference/list-legacy-voices');
  assert.deepEqual(gone.channel, { text: 'Removed in 0.12.0-beta.1', link: '/changelog/', title: REMOVED_TITLE });
  assert.match(gone.body, /^\| HTTP \| `GET \/api\/v3\/legacy-voices` \|$/m);
  assert.match(gone.body, /^## Response$/m);
  assert.match(gone.body, /The betas no longer have this operation; the latest stable release, 0\.11\.0, still does\./);
  // Nothing on these pages links to a page main does not have
  const slugs = new Set(pages.map((p) => p.slug));
  for (const p of [update, readers, gone]) for (const [, s] of (p.siteBody ?? p.body).matchAll(/\]\(\/(reference\/[^)#\s]+?)\/(?:#[^)\s]*)?\)/g)) assert.ok(slugs.has(s), `${p.slug} links to ${s}`);
});

test('the Changelog marks a change only preview or experimental operations reach, whatever the model calls preview', () => {
  const pages = [];
  const of = (surfaces) => apiSections({ api: true, version: '5.200.0', date: '2026-12-01', changes: surfaces.map((surface, i) => ({ kind: 'operationAdded', surface, operation: `Op${i}`, title: '' })) }, pages).sections[0].items;
  assert.deepEqual(of(['ga', 'preview', 'beta', 'experimental']), ['- `Op0`', '- `Op1` (preview)', '- `Op2` (preview)', '- `Op3` (experimental)']);
  assert.deepEqual(of(['preview', 'experimental']), ['- `Op0`', '- `Op1`']);
});

test('cli-channels.sh: only a 404 is "no release yet"; a 403 or any other answer fails', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const answers = { '/stable.json': [404, 'Not found'], '/beta.json': [200, '{"version": "0.12.0-beta.3", "manifest": "0.12.0-beta.3/manifest.json"}'] };
  const server = createServer((req, res) => {
    const [status, body] = answers[req.url] ?? [404, ''];
    res.writeHead(status);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-channels-'));
  const run = () =>
    new Promise((resolve) => {
      const child = spawn(path.join(root, 'scripts/cli-channels.sh'), [path.join(dir, 'out.json')], { env: { ...process.env, CLI_CHANNELS_URL: url }, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => resolve({ code, err }));
    });
  try {
    assert.equal((await run()).code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')), { stable: null, beta: '0.12.0-beta.3' });
    answers['/stable.json'] = [403, 'Access denied'];
    const refused = await run();
    assert.equal(refused.code, 1);
    assert.match(refused.err, /answered 403/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// scripts/docs-build-inputs.sh, run as each pipeline runs it, with a stand-in for cli-channels.sh that fails: a build
// that publishes stops, any other warns and goes on. CI is left unset, so the history step is not run here.
const runInputs = async (env) => {
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-inputs-'));
  const stub = path.join(dir, 'cli-channels.sh');
  fs.writeFileSync(stub, '#!/bin/sh\necho "stand-in: no channels" >&2\nexit 1\n', { mode: 0o755 });
  const base = { PATH: process.env.PATH, HOME: process.env.HOME ?? dir, CLI_CHANNELS: stub, CLI_CHANNELS_OUT: path.join(dir, 'out.json') };
  try {
    return await new Promise((resolve) => {
      const child = spawn(path.join(root, 'scripts/docs-build-inputs.sh'), [], { env: { ...base, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => resolve({ code, err }));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('a build that publishes stops when it cannot read the CLI channels; a merge request\'s build warns and goes on', async () => {
  for (const env of [{ DOCS_LIVE: 'on' }, { CI_COMMIT_TAG: 'v1.2.3' }, { CI_COMMIT_BRANCH: 'main', CI_DEFAULT_BRANCH: 'main' }]) {
    const r = await runInputs(env);
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.match(r.err, /error: could not read the CLI's channel pointers.*This build publishes, so it stops\./, JSON.stringify(env));
  }
  for (const env of [{ CI_PIPELINE_SOURCE: 'merge_request_event', CI_MERGE_REQUEST_IID: '124', CI_DEFAULT_BRANCH: 'main' }, { CI_COMMIT_BRANCH: 'docs/x', CI_DEFAULT_BRANCH: 'main' }, {}]) {
    const r = await runInputs(env);
    assert.equal(r.code, 0, JSON.stringify(env));
    assert.match(r.err, /warning: could not read the CLI's channel pointers/, JSON.stringify(env));
  }
});

test("the head script presses the switch's side from <html data-channel>, whether or not the switch's script loads", async () => {
  const vm = await import('node:vm');
  const { CHANNEL_HEAD } = await import('../src/channel-head.mjs');
  const page = (stored) => {
    const listeners = [];
    const buttons = ['stable', 'beta'].map((side) => ({ dataset: { setChannel: side }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }));
    const document = { documentElement: { dataset: {} }, addEventListener: (e, f) => e === 'DOMContentLoaded' && listeners.push(f), querySelectorAll: () => buttons };
    const localStorage = { getItem: () => (stored instanceof Error ? (() => { throw stored; })() : stored) };
    vm.runInNewContext(CHANNEL_HEAD, { document, localStorage });
    const before = document.documentElement.dataset.channel;
    for (const f of listeners) f();
    return { before, pressed: Object.fromEntries(buttons.map((b) => [b.dataset.setChannel, b.attrs['aria-pressed']])) };
  };
  // Before anything else runs, <html> names the side; once the page is parsed, the buttons say the same
  assert.deepEqual(page('beta'), { before: 'beta', pressed: { stable: 'false', beta: 'true' } });
  assert.deepEqual(page(null), { before: 'stable', pressed: { stable: 'true', beta: 'false' } });
  assert.deepEqual(page(new Error('storage refused')), { before: 'stable', pressed: { stable: 'true', beta: 'false' } });
  // The stylesheet presses the side <html> names, not the attribute the script sets later
  const css = fs.readFileSync(path.join(root, 'docs/site/src/styles/components.css'), 'utf8');
  assert.doesNotMatch(css, /caitlyn-channel-switch button\[[^\]]*\]\[aria-pressed/);
});

// What the betas dropped, against a stable model with things main has no page for: an operation whose output is a
// type main lacks, a member of a type main lacks, an experimental operation, one with no SDK method, and a member an
// experimental operation lost; and a stable doc sentence the public docs leave out
test('what main dropped: its types get pages from the stable model; what the stable reference never documented gets none', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'model/model.json'), 'utf8'));
  const main = structuredClone(raw);
  const stable = structuredClone(raw);
  const S = stable.shapes;
  const clone = (from, name, uri, traits = {}) => {
    const op = structuredClone(S[`ai.caitlyn.v3#${from}`]);
    op.traits = { ...op.traits, 'ai.caitlyn.traits#clientMethod': { namespace: 'agents.options', name: name.charAt(0).toLowerCase() + name.slice(1) }, 'smithy.api#http': { ...op.traits['smithy.api#http'], uri }, ...traits };
    return op;
  };
  // ListLegacyChanges returns a list of LegacyChange, a structure only the stable model has
  S['ai.caitlyn.v3#LegacyChange'] = { type: 'structure', members: { field: { target: 'smithy.api#String', traits: { 'smithy.api#documentation': 'The member that changed.', 'smithy.api#required': {} } } }, traits: { 'smithy.api#documentation': 'One change between two versions.' } };
  S['ai.caitlyn.v3#LegacyChangeList'] = { type: 'list', member: { target: 'ai.caitlyn.v3#LegacyChange' } };
  S['ai.caitlyn.v3#ListLegacyChangesOutput'] = { type: 'structure', members: { changes: { target: 'ai.caitlyn.v3#LegacyChangeList', traits: { 'smithy.api#required': {}, 'smithy.api#documentation': 'Every change.' } } } };
  S['ai.caitlyn.v3#ListLegacyChanges'] = { ...clone('ListVoices', 'ListLegacyChanges', '/v3/legacy-changes'), output: { target: 'ai.caitlyn.v3#ListLegacyChangesOutput' } };
  // An experimental operation, and one with no SDK method: the stable SDK reference documented neither
  S['ai.caitlyn.v3#TryLegacy'] = clone('ListVoices', 'TryLegacy', '/v3/try-legacy', { 'ai.caitlyn.traits#stability': 'experimental' });
  S['ai.caitlyn.v3#DeliverLegacy'] = clone('ListVoices', 'DeliverLegacy', '/v3/deliver-legacy', { 'ai.caitlyn.traits#noClientMethod': { reason: 'A delivery.' } });
  // UpdateAgent's legacyNote is a LegacyNote, a structure only the stable model has, with an internal sentence
  S['ai.caitlyn.v3#LegacyNote'] = { type: 'structure', members: { text: { target: 'smithy.api#String' } }, traits: { 'smithy.api#documentation': 'A note on the agent. PROTOCOL.md section 9 says how it was kept.' } };
  S['ai.caitlyn.v3#UpdateAgentInput'].members.legacyNote = { target: 'ai.caitlyn.v3#LegacyNote', traits: { 'smithy.api#documentation': 'A note the stable release still takes. The `@since` trait stamps it.' } };
  // An experimental operation in both, which main took a member from
  for (const m of [stable, main]) {
    m.shapes['ai.caitlyn.v3#TryThingInput'] = { type: 'structure', members: { keep: { target: 'smithy.api#String' }, ...(m === stable ? { gone: { target: 'smithy.api#String' } } : {}) } };
    m.shapes['ai.caitlyn.v3#TryThing'] = { ...structuredClone(m.shapes['ai.caitlyn.v3#ListVoices']), input: { target: 'ai.caitlyn.v3#TryThingInput' } };
    m.shapes['ai.caitlyn.v3#TryThing'].traits['ai.caitlyn.traits#stability'] = 'experimental';
    m.shapes['ai.caitlyn.v3#TryThing'].traits['ai.caitlyn.traits#clientMethod'] = { namespace: 'agents.options', name: 'tryThing' };
    m.shapes['ai.caitlyn.v3#TryThing'].traits['smithy.api#http'] = { ...m.shapes['ai.caitlyn.v3#TryThing'].traits['smithy.api#http'], uri: '/v3/try-thing' };
  }
  const service = S['ai.caitlyn.v3#Caitlyn'];
  service.operations = [...service.operations, ...['ListLegacyChanges', 'TryLegacy', 'DeliverLegacy', 'TryThing'].map((n) => ({ target: `ai.caitlyn.v3#${n}` }))];
  main.shapes['ai.caitlyn.v3#Caitlyn'].operations.push({ target: 'ai.caitlyn.v3#TryThing' });

  const c = apiChannels({ ch: { stable: '0.11.0', beta: '0.12.0-beta.1' }, models: { stable, betas: [{ version: '0.12.0-beta.1', model: main }], main } });
  // Only what the stable reference documented is kept
  assert.deepEqual([...c.removedOperations.keys()], ['ListLegacyChanges']);
  assert.equal(c.removedMembers.get('TryThingInput'), undefined);
  // The stable model's documentation passes the public-docs filter, as main's does
  assert.equal(c.stableModel.shapes['ai.caitlyn.v3#LegacyNote'].traits['smithy.api#documentation'], 'A note on the agent.');
  assert.equal(c.stableModel.shapes['ai.caitlyn.v3#UpdateAgentInput'].members.legacyNote.traits['smithy.api#documentation'], 'A note the stable release still takes.');

  const ast = loadModel();
  ast.channels = c;
  const { pages } = referencePages(ast, { unreleased: new Set(), next: null });
  const removed = pages.filter((p) => p.removed).map((p) => p.slug).sort();
  assert.deepEqual(removed, ['reference/list-legacy-changes', 'reference/types/legacy-change', 'reference/types/legacy-note']);
  // The removed operation names its output's type, and links to its page
  const op = pages.find((p) => p.slug === 'reference/list-legacy-changes');
  assert.match(op.body, /^\| `changes` \(required\) \| list of \[LegacyChange\]\(\/reference\/types\/legacy-change\/\) \| body \| Every change\. \|$/m);
  const type = pages.find((p) => p.slug === 'reference/types/legacy-change');
  assert.deepEqual(type.channel, { text: 'Removed in 0.12.0-beta.1', link: '/changelog/', title: REMOVED_TITLE });
  assert.match(type.body, /The betas no longer have this type; the latest stable release, 0\.11\.0, still does\./);
  assert.match(type.body, /One change between two versions\./);
  assert.match(type.body, /`field`/);
  // The removed member names its type, in the Markdown copy and on the site, with the stable model's own words
  const update = pages.find((p) => p.operation?.name === 'UpdateAgent');
  assert.match(update.body, /^\| `legacyNote` \(removed in 0\.12\.0-beta\.1\) \| \[LegacyNote\]\(\/reference\/types\/legacy-note\/\) \| body \| A note the stable release still takes\. \|$/m);
  assert.match(update.siteBody, /`legacyNote`[\s\S]*?\[LegacyNote\]\(\/reference\/types\/legacy-note\/\)/);
  assert.doesNotMatch(pages.find((p) => p.slug === 'reference/types/legacy-note').body, /PROTOCOL\.md/);
  // Nothing drawn from the stable model links to a page that is not built
  const slugs = new Set(pages.map((p) => p.slug));
  for (const p of pages.filter((q) => q.removed || q === update)) for (const [, s] of (p.siteBody ?? p.body).matchAll(/\]\(\/(reference\/[^)#\s]+?)\/(?:#[^)\s]*)?\)/g)) assert.ok(slugs.has(s), `${p.slug} links to ${s}`);
});

test("a changed member's label names the first beta with main's form, not the first with any change", () => {
  const as = (target, required) => ({ ...CHANGED, to: { target, required } });
  const c = apiChannels({ ch: CH, models: MODELS, diff: DIFF({ b1: [as('smithy.api#Long', false)], b2: [as('smithy.api#String', true)], main: [as('smithy.api#String', true)] }) });
  assert.equal(c.changed.get('UpdateAgentInput$ifMatch').arrival.beta, '0.12.0-beta.2');
});
