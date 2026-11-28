// The CLI section of the developer docs (/cli/, the CLI design's sections 20 and 21). The command reference is the
// CLI's own description of itself: docs/cli/tree.json, which the CLI's tests write from the live command tree and the
// command manifest (cli/internal/spec/commands.json, with cli/naming.yaml) and fail on while it differs, so the pages,
// `caitlyn help --format markdown` and `caitlyn commands --json` can never say different things. This module turns it
// into pages, the CLI tab on the SDK and API references' operation pages, the "In the CLI" section of each error page,
// the CLI's llms.txt files, and the checks that keep the section complete and every command on the site real:
//
//   cliPages             the command reference (a page per group, or per command where a group's page would be too
//                        long), its start page, the exit codes and the errors index
//   cliExamples          each operation's @examples as command lines, for the CLI tab
//   errorSection         the "In the CLI" section of an error code's page
//   cliProblems          coverage: every command, flag, exit code and error code in the manifest is on its page; every
//                        error code has a fix and a hint; the description is not older than the manifest
//   commandProblems      every `caitlyn …` on any page parses against the command tree
//   llmsFiles            /cli/llms.txt and /cli/llms-full.txt, within their size budgets
//
// The hand-written CLI pages are in docs/cli/ and are read with every other hand-written page (scripts/docs-guides.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { kebab, publishedModel, root } from './docs-model.mjs';
import { sinceVersion } from './docs-metadata.mjs';

export const SITE = 'https://build.caitlyn.ai';
export const TREE_FILE = 'docs/cli/tree.json';
export const MANIFEST_FILE = 'cli/internal/spec/commands.json';
const UPDATE = 'run `go test ./internal/commands/describe -run TestDocsSnapshot -update` in cli/ and commit docs/cli/tree.json';

// Size budgets (20.2), in tokens, counted as characters / 4 (a conservative estimate for English and code)
export const LLMS_BUDGET = 8000;
export const LLMS_FULL_BUDGET = 20000;
export const PAGE_BUDGET = 4000;
export const tokens = (text) => Math.ceil(text.length / 4);

/** The CLI's description of itself (docs/cli/tree.json) and the command manifest. */
export function loadCli({ treeFile = path.join(root, TREE_FILE), manifestFile = path.join(root, MANIFEST_FILE) } = {}) {
  const snapshot = JSON.parse(fs.readFileSync(treeFile, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  return { snapshot, manifest, tree: snapshot.tree };
}

/** Absolute links to the site become site-relative, so the build checks each one names a page. */
export const localLinks = (md) => md.replaceAll(`](${SITE}/`, '](/');

/** A command's page and anchor on the site: its group's page and its section, or a top-level command's own page. */
export const sitePath = (url) => url.replace(SITE, '');

// ---------------------------------------------------------------------------------------------------- the pages

/** Where each hand-written CLI page sits in the sidebar, by group, in order. A page not listed goes in "Using the CLI". */
export const CLI_SECTIONS = [
  { label: 'Using the CLI', pages: [] },
  { label: 'Recipes', prefix: 'cli/recipes/', pages: [] },
  { label: 'Automation', pages: ['cli/ai-agents'] },
  { label: 'Reference tables', pages: ['cli/exit-codes', 'cli/errors', 'cli/telemetry'] },
];

const resourcesFor = (operations, manifest) => {
  const out = new Set();
  for (const name of operations ?? []) {
    const op = manifest.operations[name];
    if (!op) continue;
    const uri = op.uri;
    if (/\/agents/.test(uri)) out.add('agent');
    if (/\/versions/.test(uri) && /\/agents/.test(uri)) out.add('version');
    if (/\/conversations/.test(uri)) out.add('conversation');
    if (/\/knowledge-bases/.test(uri)) out.add('knowledge-base');
    if (/\/documents/.test(uri)) out.add('document');
    if (/\/uploads/.test(uri)) out.add('upload');
    if (/\/operations/.test(uri)) out.add('operation');
  }
  return [...out];
};

const sinceOf = (operations, manifest) => {
  const versions = (operations ?? []).map((o) => publishedModel()?.since.get(o) ?? manifest.operations[o]?.since).filter((v) => /^\d+\.\d+\.\d+$/.test(v ?? ''));
  return versions.length ? Math.min(...versions.map(sinceVersion)) : 0;
};

/**
 * The generated CLI pages: { slug, title, metadata, body, kind: 'cli', group, hidden, source }. `errorCodes` is
 * docs/error-codes.mjs's ERROR_CODES, for the errors index's fixes.
 */
/**
 * A command whose page leads with a session people would see at a terminal, taken from an example's transcript (the
 * output between its "## <name>" line and the next): after the page's usage block, before its description.
 */
export const SESSIONS = {
  chat: { file: 'examples/cli/ask-an-agent', name: 'session', intro: 'On a terminal, with no message, `chat` is a conversation you type into:' },
};
export function withSession(command, md, { read = (f) => fs.readFileSync(path.join(root, f), 'utf8') } = {}) {
  const s = SESSIONS[command];
  if (!s) return md;
  const tr = read(`${s.file}.out`).split('\n');
  const start = tr.indexOf(`## ${s.name}`);
  if (start < 0) throw new Error(`${s.file}.out has no "## ${s.name}" section, which the ${command} page shows`);
  let end = start + 1;
  while (end < tr.length && !tr[end].startsWith('## ') && !tr[end].startsWith('[exit ')) end++;
  const session = tr.slice(start + 1, end).join('\n').replace(/\n+$/, '');
  const at = md.indexOf('```\n', md.indexOf('```sh\n')) + 4;
  return `${md.slice(0, at)}\n${s.intro}\n\n\`\`\`text\n${session}\n\`\`\`\n${md.slice(at)}`;
}

export function cliPages({ snapshot, manifest }, { errorCodes = {} } = {}) {
  const pages = [];
  const tree = snapshot.tree;
  const allOps = [...new Set(snapshot.pages.flatMap((p) => p.operations ?? []))].sort();
  pages.push({
    slug: 'cli/reference',
    title: 'Command reference',
    metadata: { pageType: 'cli', sinceVersion: sinceOf(allOps, manifest), resources: resourcesFor(allOps, manifest), integrations: [], operations: allOps },
    body: localLinks(snapshot.reference),
    kind: 'cli',
    group: 'reference',
    source: TREE_FILE,
  });
  for (const p of snapshot.pages) {
    pages.push({
      slug: `cli/reference/${p.path.join('/')}`,
      title: p.title,
      metadata: { pageType: 'cli', sinceVersion: sinceOf(p.operations, manifest), resources: resourcesFor(p.operations, manifest), integrations: [], operations: p.operations ?? [] },
      body: withSession(p.path.join(' '), localLinks(p.markdown)),
      kind: 'cli',
      group: 'reference',
      cliPath: p.path,
      commands: p.commands,
      hidden: !!p.hidden,
      source: TREE_FILE,
    });
  }
  pages.push({
    slug: 'cli/exit-codes',
    title: 'Exit codes',
    metadata: { pageType: 'cli', sinceVersion: 0, resources: [], integrations: [], operations: [] },
    body: exitCodesPage(tree),
    kind: 'cli',
    source: TREE_FILE,
  });
  pages.push({
    slug: 'cli/errors',
    title: 'Errors in the CLI',
    metadata: { pageType: 'cli', sinceVersion: 0, resources: [], integrations: [], operations: [] },
    body: errorsIndex(tree, errorCodes),
    kind: 'cli',
    source: TREE_FILE,
  });
  return pages;
}

const cell = (s) => String(s ?? '').replace(/\n/g, ' ').replace(/\|/g, '\\|').trim();

function exitCodesPage(tree) {
  const byExit = new Map();
  for (const e of Object.values(tree.errors)) {
    if (!byExit.has(e.exitCode)) byExit.set(e.exitCode, []);
    byExit.get(e.exitCode).push(e.code);
  }
  const out = [];
  out.push('Every command ends with one of these exit codes, and they never change meaning, so a script or an AI agent can branch on them. Every error the CLI prints as JSON carries its exit code as `exitCode`, and a hint of what to run next. `caitlyn help exit-codes` prints this table.', '');
  out.push('| Exit code | Meaning | Error codes |', '| --- | --- | --- |');
  for (const e of tree.exitCodes) {
    const codes = (byExit.get(e.code) ?? []).sort().map((c) => `[\`${c}\`](/errors/${c}/)`).join(', ');
    const from = e.from ? `${cell(e.meaning)}. From: ${cell(e.from)}` : cell(e.meaning);
    out.push(`| ${e.code} | ${from} | ${codes} |`);
  }
  out.push('');
  out.push('## Errors on stderr', '');
  out.push('When stderr is not a terminal, in CI, or when an AI agent runs the CLI, an error is one JSON object on stderr: the problem details Caitlyn sent, with the exit code and a hint whose `next` commands reuse the identifiers and flags of the command that failed. A person at a terminal gets the same error as a message instead, whatever `--output` says. `--error-format json` or `CAITLYN_ERROR_FORMAT=json` asks for the JSON anywhere, and `human` for the message; the flag wins over the variable. See [When something fails](/cli/#when-something-fails).', '');
  const pf = tree.errors.PRECONDITION_FAILED;
  const sample = {
    error: {
      type: `${SITE}/errors/PRECONDITION_FAILED/`,
      title: 'Precondition failed',
      status: 412,
      code: 'PRECONDITION_FAILED',
      detail: "The draft's ETag is now \"draft-43\".",
      requestId: '01JC9Q2W7R4M0H2T6N1S8V3B5X',
      exitCode: pf?.exitCode ?? 7,
      hint: { next: (pf?.hint?.next ?? []).map((n) => ({ run: n.run.replace(/<agent>/g, 'GHT7YRWXPL'), why: n.why })), docs: `${SITE}/cli/reference/agents/draft/#update` },
    },
  };
  out.push('```json', JSON.stringify(sample, null, 2), '```', '');
  out.push('On a terminal, a person gets the same as text, with each next step as a `try:` line.', '');
  out.push('## Exit code 3: an answer is needed', '');
  out.push('A command that would ask a question exits 3 when there is nobody to ask: in CI, when an AI agent runs it, with `--no-input`, or when stdin is not a terminal. The hint names the flag that gives the answer, such as `--yes` for a destructive command, or `--confirm <id>` for the highest-impact ones.', '');
  out.push('## See also', '', '- [Errors in the CLI](/cli/errors/): every error code, its exit code and the CLI\'s hint.', '- [AI agents](/cli/ai-agents/): how an agent should recover from each.', '');
  return out.join('\n');
}

function errorsIndex(tree, errorCodes) {
  const out = [];
  out.push("Every error code a command can return, with the exit code it ends the command with and what the CLI suggests running next. Each code's page says what it means and how to fix it; its \"In the CLI\" section names the commands that can return it.", '');
  out.push('| Code | Status | Exit code | The CLI suggests |', '| --- | --- | --- | --- |');
  for (const e of Object.values(tree.errors).sort((a, b) => a.code.localeCompare(b.code))) {
    out.push(`| [\`${e.code}\`](/errors/${e.code}/) | ${e.status} | ${e.exitCode} | ${cell(hintWords(e))} |`);
  }
  out.push('');
  if (Object.keys(errorCodes).length) out.push('Every page in the [error reference](/errors/) applies to the CLI as it does to the SDKs: the same codes, from the same server.', '');
  return out.join('\n');
}

/** What the CLI suggests for an error code, in words for a table cell. */
function hintWords(e) {
  if (e.hint?.next?.length) return e.hint.next.map((n) => `\`${n.run}\` (${n.why})`).join('; ');
  if (e.hintFrom === 'fields') return 'Each field error names the flag that set it';
  return 'See its page';
}

// ------------------------------------------------------------------------------------------------- cross-links

/**
 * Each operation's examples as CLI command lines, by operation name: [{ title, line, command, docs }]. An operation
 * behind several commands (an agent version's get, as `agents versions get`, `agents draft get` and `agents live get`)
 * takes each example from the command that says it most plainly: the one whose fixed version matches the example,
 * else the one with no fixed version.
 */
export function cliExamples(tree) {
  const byOp = new Map();
  for (const c of tree.commands) {
    if (!c.operation || !c.examples?.length) continue;
    if (!byOp.has(c.operation)) byOp.set(c.operation, []);
    byOp.get(c.operation).push(c);
  }
  const out = new Map();
  for (const [op, commands] of byOp) {
    const titles = new Map();
    // A fixed scope's command (agents draft get) reads better than the general one with @draft: prefer the longer path
    // when two commands give the same example, then the general one
    for (const c of commands.sort((a, b) => b.path.length - a.path.length)) {
      for (const ex of c.examples) {
        const prev = titles.get(ex.title);
        const plain = !/@(draft|live)\b/.test(ex.line);
        if (!prev || (plain && !prev.plain)) titles.set(ex.title, { title: ex.title, line: ex.line, command: c.name, docs: sitePath(c.docs), plain, error: ex.error, exitCode: ex.exitCode });
      }
    }
    out.set(op, [...titles.values()]);
  }
  return out;
}

/** The commands behind each operation: [{ name, docs }], for the CLI row of an operation page's header. */
export function commandsByOperation(tree) {
  const out = new Map();
  for (const c of tree.commands) {
    if (!c.operation || c.hidden) continue;
    if (!out.has(c.operation)) out.set(c.operation, []);
    out.get(c.operation).push({ name: c.name, docs: sitePath(c.docs), general: (c.args ?? []).some((a) => a.version), depth: c.path.length });
  }
  // The general command first (agents versions get, which takes any version, before agents draft get), then the
  // shortest
  for (const list of out.values()) list.sort((a, b) => Number(b.general) - Number(a.general) || a.depth - b.depth || a.name.localeCompare(b.name));
  return out;
}

/** The "In the CLI" section of an error code's page (/errors/<CODE>/), or '' for a code no command returns. */
export function errorSection(code, tree) {
  const e = tree.errors[code];
  if (!e) return '';
  const meaning = tree.exitCodes.find((x) => x.code === e.exitCode)?.meaning ?? '';
  const out = ['## In the CLI', ''];
  out.push(`A command that gets this error exits with code ${e.exitCode} (${meaning.replace(/\.$/, '').toLowerCase()}; [Exit codes](/cli/exit-codes/)). The error is printed on stderr: as JSON with \`exitCode\` and a \`hint\` for scripts, CI and AI agents, and as a message for a person at a terminal ([When something fails](/cli/#when-something-fails)).`, '');
  if (e.hint?.next?.length) {
    out.push(`For \`caitlyn ${e.hintCommand}\`, the hint suggests:`, '');
    for (const n of e.hint.next) out.push(`- \`${n.run}\`: ${n.why}`);
    out.push('', 'Each command reuses the identifiers and flags of the command that failed.', '');
  } else if (e.hintFrom === 'fields') {
    out.push('Each field error is named by the flag that set it (`--name`, or `--set guidance.instructions` for a nested member), so the command to fix is plain.', '');
  }
  const visible = e.commands.filter((name) => !tree.commands.find((c) => c.name === name)?.hidden);
  if (visible.length <= 12) {
    out.push(`Commands that document it: ${visible.map((name) => `[\`caitlyn ${name}\`](${sitePath(tree.commands.find((c) => c.name === name).docs)})`).join(', ')}.`, '');
  } else {
    out.push(`${visible.length} commands document it; any command that calls Caitlyn can return it. [Errors in the CLI](/cli/errors/) lists every code.`, '');
  }
  return out.join('\n');
}

// --------------------------------------------------------------------------------------------- the coverage

/**
 * Error codes with no hint from the CLI yet, and no field errors to name a flag with. Each needs a `next` entry in
 * cli/naming.yaml (what to run to fix it) before it leaves this list; the build fails for any code with no hint that
 * is not here, and for any code here that has one. Listed rather than given an invented fix.
 */
// Every error now carries at least the command's own help as its next step; a code listed here would have no
// hint at all. Codes still waiting for a specific next step in naming.yaml are a follow-up, listed in the MR.
export const NO_CLI_HINT_YET = [];

const headingAt = (md, name) => new RegExp(`^#{1,3} ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(md);

/**
 * The CLI section's coverage problems (20.1), as strings. `pages` are the generated CLI pages; `errorCodes` is
 * docs/error-codes.mjs's ERROR_CODES.
 */
export function cliProblems({ snapshot, manifest, tree }, pages, { errorCodes = {}, noHint = NO_CLI_HINT_YET } = {}) {
  const problems = [];
  // The description is the manifest's: a manifest newer than it means the snapshot was not updated
  if (tree.cli.modelVersion !== manifest.modelVersion) problems.push(`${TREE_FILE} describes the model ${tree.cli.modelVersion}, but ${MANIFEST_FILE} is ${manifest.modelVersion}: ${UPDATE}`);
  const byName = new Map(tree.commands.map((c) => [c.name, c]));
  for (const c of manifest.commands) {
    const name = c.path.join(' ');
    const d = byName.get(name);
    if (!d) {
      problems.push(`caitlyn ${name} is in the manifest but not in ${TREE_FILE}: ${UPDATE}`);
      continue;
    }
    if (d.operation !== (c.operation ?? '') && !(c.kind === 'wait' && !d.operation)) problems.push(`caitlyn ${name} calls ${c.operation} in the manifest, but ${d.operation} in ${TREE_FILE}: ${UPDATE}`);
  }
  // Every command is documented in full on one page, with every flag, exit code and error code; every group has a page
  const pageOf = new Map();
  for (const p of pages) for (const name of p.commands ?? []) pageOf.set(name, p);
  const pageAt = new Map(pages.filter((p) => p.cliPath).map((p) => [p.cliPath.join(' '), p]));
  for (const c of tree.commands) {
    if (c.kind === 'group') {
      if (!pageAt.has(c.name)) problems.push(`the group caitlyn ${c.name} has no page`);
      continue;
    }
    const p = pageOf.get(c.name);
    if (!p) {
      problems.push(`caitlyn ${c.name} is documented on no page`);
      continue;
    }
    const verb = c.path[c.path.length - 1];
    const own = p.cliPath.join(' ') === c.name;
    if (!own && !headingAt(p.body, verb)) problems.push(`${p.slug}: no section for caitlyn ${c.name}`);
    // Its address (the help footer's and every hint's docs link) names a heading on a page
    const [target, anchor] = sitePath(c.docs).split('#');
    const at = pages.find((q) => `/${q.slug}/` === target);
    if (!at) problems.push(`caitlyn ${c.name}'s address ${c.docs} names no page`);
    else if (anchor && !headingAt(at.body, anchor)) problems.push(`caitlyn ${c.name}'s address ${c.docs} names no section on ${at.slug}`);
    for (const f of c.flags ?? []) {
      if (!f.hidden && !p.body.includes(`\`--${f.name}\``)) problems.push(`${p.slug}: caitlyn ${c.name}'s flag --${f.name} is not on its page`);
    }
    for (const x of c.exitCodes) if (!new RegExp(`^\\| ${x} \\|`, 'm').test(p.body)) problems.push(`${p.slug}: caitlyn ${c.name}'s exit code ${x} is not on its page`);
    for (const e of c.errors ?? []) if (!p.body.includes(`\`${e.code}\``)) problems.push(`${p.slug}: caitlyn ${c.name}'s error code ${e.code} is not on its page`);
    if (c.operation) {
      const op = manifest.operations[c.operation];
      for (const code of new Set((op?.errors ?? []).flatMap((e) => e.codes ?? []))) {
        if (!(c.errors ?? []).some((e) => e.code === code)) problems.push(`caitlyn ${c.name}: the manifest's error code ${code} is not in ${TREE_FILE}: ${UPDATE}`);
      }
    }
  }
  // Every error code has a fix (its page's "What to do") and a hint (the CLI's next steps, or its field errors named
  // by flag)
  const manifestCodes = new Set(Object.values(manifest.operations).flatMap((op) => op.errors.flatMap((e) => e.codes ?? [])));
  for (const code of [...manifestCodes].sort()) {
    if (!errorCodes[code]?.action) problems.push(`the error code ${code} has no fix: add its action to docs/error-codes.mjs`);
    const e = tree.errors[code];
    if (!e) {
      problems.push(`the error code ${code} is not in ${TREE_FILE}: ${UPDATE}`);
      continue;
    }
    const hinted = !!e.hintFrom;
    if (!hinted && !noHint.includes(code)) problems.push(`the error code ${code} has no hint in the CLI: add its next steps under \`next\` in cli/naming.yaml`);
    if (hinted && noHint.includes(code)) problems.push(`the error code ${code} has a hint now: take it out of NO_CLI_HINT_YET in scripts/docs-cli.mjs`);
  }
  for (const code of noHint) if (!manifestCodes.has(code)) problems.push(`NO_CLI_HINT_YET lists ${code}, which no operation returns`);
  // Every page within its size budget
  for (const p of pages) if (p.cliPath && tokens(p.body) > PAGE_BUDGET) problems.push(`${p.slug} is about ${tokens(p.body)} tokens, over ${PAGE_BUDGET}`);
  return problems;
}

// ---------------------------------------------------------------------------------------- every command parses

/**
 * Commands and flags the hand-written pages name before this branch's CLI has them: other parts of the CLI add them
 * (sign-in, configuration, telemetry, chat, sync, the API command). A command here is accepted with the flags listed;
 * once the command tree has it, the build fails until it is taken out, so the list only shrinks.
 */
export const PENDING_COMMANDS = {
  // Unattended runs aren't in this model yet: the command arrives with them
  'unattended-runs start': ['--prompt', '--attach', '--wait', '--timeout', '--download'],
};

/** Shell words of a command line: quotes kept together, placeholders (<agent>, [flags], …) as words, and the line cut
 * at a pipe, a list operator, a redirect or a comment. */
export function shellWords(line) {
  const words = [];
  let i = 0;
  const s = line.replace(/\\\n\s*/g, ' ');
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    // A placeholder such as <agent>, <etag> or <command> is a word here, not a redirect
    const ph = /^<[^<>\s][^<>]*>/.exec(s.slice(i));
    if (ph && (i + ph[0].length === s.length || /[\s]/.test(s[i + ph[0].length]))) {
      words.push({ text: ph[0], placeholder: true });
      i += ph[0].length;
      continue;
    }
    if (/^(\|\|?|&&|;|&|>>?|2>|<|#)/.test(s.slice(i))) break;
    let w = '';
    let quoted = false;
    let variable = false;
    while (i < s.length && !/\s/.test(s[i])) {
      const ch = s[i];
      if (ch === "'") {
        const end = s.indexOf("'", i + 1);
        w += s.slice(i + 1, end < 0 ? s.length : end);
        i = end < 0 ? s.length : end + 1;
        quoted = true;
      } else if (ch === '"') {
        let j = i + 1;
        while (j < s.length && s[j] !== '"') {
          if (s[j] === '\\') j++;
          if (s[j] === '$') variable = true;
          j++;
        }
        w += s.slice(i + 1, j).replace(/\\(.)/g, '$1');
        i = j + 1;
        quoted = true;
      } else if (ch === '\\') {
        // An escaped character outside quotes is itself ('\'' inside a single-quoted word)
        w += s[i + 1] ?? '';
        i += 2;
      } else if (/[|;&>]/.test(ch) || (ch === '<' && !w)) {
        break;
      } else {
        if (ch === '$') variable = true;
        w += ch;
        i++;
      }
    }
    const placeholder = !quoted && (/^\[.*\]\.*$/.test(w) || /^(…|\.\.\.)$/.test(w) || /<[^>]+>/.test(w) || w.includes('…'));
    words.push({ text: w, quoted, variable, placeholder });
    if (/^(\|\|?|&&|;|&|>>?)/.test(s.slice(i))) break;
  }
  return words;
}

/**
 * The problems with one `caitlyn …` command line, against the command tree: an unknown command, an unknown flag, a
 * flag missing its value, an unknown output format, or more arguments than the command takes. Placeholders (<id>,
 * [flags], …) stand for any value; a command in PENDING_COMMANDS is accepted with the flags it lists.
 */
export function commandLineProblems(line, tree, { pending = PENDING_COMMANDS } = {}) {
  const words = shellWords(line);
  if (!words.length || words[0].text !== 'caitlyn') return [];
  const byName = new Map(tree.commands.map((c) => [c.name, c]));
  const childOf = (prefix, word) => {
    for (const c of tree.commands) {
      if (c.path.length !== prefix.length + 1 || c.path.slice(0, -1).join(' ') !== prefix.join(' ')) continue;
      if (c.path[c.path.length - 1] === word || (c.aliases ?? []).includes(word)) return c;
    }
    return null;
  };
  const globals = new Map();
  for (const f of tree.globalFlags) {
    globals.set(`--${f.name}`, f);
    if (f.shorthand) globals.set(`-${f.shorthand}`, f);
  }
  const takesValue = (f) => f.type !== 'bool' && !f.noOptValue;
  const problems = [];
  // The command as typed (aliases kept) and as named (aliases spelt out); a pending command matches either
  const typed = [];
  const path = [];
  let cmd = null;
  let pendingFlags = null;
  let args = 0;
  let rest = false;
  const flagsOf = () => {
    const m = new Map(globals);
    for (const f of cmd?.flags ?? []) {
      m.set(`--${f.name}`, f);
      if (f.shorthand) m.set(`-${f.shorthand}`, f);
      for (const a of f.aliases ?? []) m.set(`--${a}`, f);
    }
    return m;
  };
  const pendingKey = (word) => [[...typed, word].join(' '), [...path, word].join(' ')].find((k) => k in pending);
  const pendingPrefix = (word) => [[...typed, word].join(' '), [...path, word].join(' ')].some((k) => Object.keys(pending).some((p) => p.startsWith(`${k} `)));
  const where = line.trim();
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    // caitlyn api reads its own flags: an operation's members by name (--kb), or --field for any path
    if (cmd?.name === 'api') break;
    if (!w.quoted && w.text.startsWith('-') && w.text !== '-' && !w.placeholder) {
      const [name, inline] = w.text.split(/=(.*)/s);
      if (name === '--help' || name === '-h') continue;
      if (pendingFlags && !globals.has(name)) {
        if (!pendingFlags.includes(name)) problems.push(`\`${where}\`: ${name} is not a flag of caitlyn ${typed.join(' ')}`);
        // A pending command's flag takes the next word as its value, unless that is a flag
        if (inline === undefined && words[i + 1] && !words[i + 1].text.startsWith('-')) i++;
        continue;
      }
      const f = flagsOf().get(name);
      if (!f) {
        problems.push(`\`${where}\`: ${name} is not a flag of caitlyn ${typed.join(' ') || '(the root)'}`);
        continue;
      }
      let value = inline;
      if (takesValue(f) && inline === undefined) {
        const next = words[i + 1];
        if (!next) {
          problems.push(`\`${where}\`: ${name} needs a value`);
          continue;
        }
        value = next.text;
        i++;
        if (next.placeholder || next.variable) continue;
      }
      if (f.name === 'output' && value !== undefined && !['table', 'json', 'jsonl', 'yaml', 'text'].includes(value)) problems.push(`\`${where}\`: ${value} is not an output format`);
      continue;
    }
    // A word: the next part of the command while there is one to name, else an argument. An optional placeholder
    // ([flags], [dir], …) stands for nothing in particular, so it is not counted.
    if (pendingFlags || rest || (cmd && cmd.kind === 'command')) {
      if (!(w.placeholder && /^(\[|…|\.\.\.)/.test(w.text))) args++;
      continue;
    }
    if (w.placeholder) {
      // caitlyn <command> [flags], caitlyn agents draft <command>: a placeholder for the rest of the command
      rest = true;
      continue;
    }
    // help as the last word is help, as --help is (caitlyn agents help), where the command takes no argument
    const noArgs = (c) => c.kind === 'group' || (!(c.args ?? []).length && !/<|\[(?!flags\])/.test(c.usage ?? ''));
    if (w.text === 'help' && !w.quoted && cmd && i === words.length - 1 && !childOf(path, 'help') && noArgs(cmd)) continue;
    const next = childOf(path, w.text);
    if (next) {
      typed.push(w.text);
      path.push(next.path[next.path.length - 1]);
      cmd = next;
      continue;
    }
    const key = pendingKey(w.text);
    if (key) {
      if (byName.has(key)) problems.push(`caitlyn ${key} is in the command tree now: take it out of PENDING_COMMANDS in scripts/docs-cli.mjs`);
      typed.push(w.text);
      path.push(w.text);
      pendingFlags = pending[key];
      continue;
    }
    if (pendingPrefix(w.text)) {
      // The first word of a pending command (auth in auth login)
      typed.push(w.text);
      path.push(w.text);
      cmd = { kind: 'group', path: [...path], flags: [] };
      continue;
    }
    problems.push(`\`${where}\`: caitlyn ${[...typed, w.text].join(' ')} is not a command`);
    return problems;
  }
  if (cmd && cmd.kind === 'command' && !pendingFlags) {
    const max = (cmd.args ?? []).some((a) => a.repeatable) ? Infinity : (cmd.args ?? []).length;
    if (args > max) problems.push(`\`${where}\`: caitlyn ${cmd.name} takes ${max} argument${max === 1 ? '' : 's'}, not ${args}`);
  }
  return problems;
}

/** Every `caitlyn …` on a page: command lines in shell and console blocks (a console block's `$ ` lines), and inline
 * code that starts with `caitlyn `. */
export function commandLines(markdown) {
  const out = [];
  const lines = markdown.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /^\s*(```+)\s*([\w-]*)/.exec(line);
    if (open && !fence) {
      fence = { marker: open[1], lang: open[2] };
      continue;
    }
    if (fence && line.trim() === fence.marker) {
      fence = null;
      continue;
    }
    if (fence) {
      if (!['sh', 'bash', 'shell', 'console', 'yaml', 'yml'].includes(fence.lang)) continue;
      let text = line;
      if (fence.lang === 'console') {
        if (!/^\s*\$ /.test(text)) continue;
        text = text.replace(/^\s*\$ /, '');
      }
      // In YAML (a CI job's script), a list item's command
      if (fence.lang === 'yaml' || fence.lang === 'yml') text = text.replace(/^\s*-\s+/, '');
      text = text.trimStart();
      if (!/^caitlyn(\s|$)/.test(text)) continue;
      while (/\\$/.test(text) && i + 1 < lines.length) text = `${text.slice(0, -1)} ${lines[++i].trim()}`;
      out.push(text);
      continue;
    }
    for (const m of line.matchAll(/`(caitlyn(?: [^`]*)?)`/g)) out.push(m[1]);
  }
  return out;
}

/** The problems with every `caitlyn …` on the pages (20.1): [where, problem]. */
export function commandProblems(pages, tree, options) {
  const out = [];
  for (const p of pages) {
    for (const line of commandLines(p.body)) for (const problem of commandLineProblems(line, tree, options)) out.push([p.source === TREE_FILE ? `${p.slug} (generated)` : (p.source ?? p.slug), problem]);
  }
  return out;
}

/**
 * What a command prints, shown on a page, is never written by hand: every code block in the run of blocks after an
 * output marker
 *   <!-- output: examples/cli/output-formats.sh -->
 * (one block, or an output tab group: `tab-output="Table"`, `tab-output="JSON"`, ...) must be a run of whole lines of
 * that example's transcript (examples/cli/<name>.out), which scripts/cli-examples.mjs checks against the CLI on every
 * pipeline. So a page's output changes when the CLI's does, or the build fails.
 */
export const OUTPUT_MARKER = /^<!-- output: (examples\/cli\/[\w-]+)\.sh -->$/;
export function uncapturedOutput(page, { read = (f) => fs.readFileSync(path.join(root, f), 'utf8') } = {}) {
  const out = [];
  const lines = page.body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = OUTPUT_MARKER.exec(lines[i]);
    if (!m) continue;
    let transcript;
    try {
      transcript = read(`${m[1]}.out`).split('\n');
    } catch {
      out.push(`line ${i + 1}: ${m[1]}.out doesn't exist; run make cli-examples to write it`);
      continue;
    }
    let at = i + 1;
    let blocks = 0;
    while (/^\s*```/.test(lines[at] ?? '')) {
      const close = lines.findIndex((l, j) => j > at && /^\s*```\s*$/.test(l));
      const block = lines.slice(at + 1, close < 0 ? lines.length : close);
      const found = block.length > 0 && transcript.some((_, k) => block.every((l, n) => transcript[k + n] === l));
      if (!found) out.push(`line ${at + 1}: this output isn't in ${m[1]}.out: copy it from the transcript, never write it by hand`);
      blocks++;
      at = close < 0 ? lines.length : close + 1;
    }
    if (!blocks) out.push(`line ${i + 1}: an output marker must be followed by a code block`);
  }
  return out;
}

// The HTML a page may write on purpose; any other <name> in prose is a placeholder the renderer would swallow
const HTML_TAGS = new Set(('a abbr aside b blockquote br button caption code col colgroup dd del details div dl dt em figcaption figure ' +
  'footer h1 h2 h3 h4 h5 h6 header hr i img input ins kbd label li main mark nav ol p path picture pre q s samp section ' +
  'small source span strong style sub summary sup svg table tbody td tfoot th thead time tr u ul var video wbr script').split(' '));
/** The `<placeholder>`s in a page's prose (outside code) that would be read as HTML tags: [problem]. */
export function swallowedPlaceholders(body) {
  const out = [];
  let fence = false;
  body.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      return;
    }
    if (fence || /^\s*<!--/.test(line)) return;
    const text = line.replace(/`[^`]*`/g, '');
    for (const m of text.matchAll(/(^|[^\\])<([A-Za-z][\w@.[\]|-]*)>/g)) {
      const name = m[2].toLowerCase();
      if (HTML_TAGS.has(name) || /^(caitlyn|starlight|astro)-/.test(name)) continue;
      out.push(`line ${i + 1}: <${m[2]}> outside code would be read as an HTML tag and disappear; write \\<${m[2]}> or put it in code`);
    }
  });
  return out;
}

/** A console block's `$ caitlyn` lines show a session the reader can trust, so each comes from an example that runs
 * against the mock (examples/cli/): on a hand-written page, a console block with a command must follow an example marker. */
export function unrunConsoleBlocks(page) {
  const out = [];
  const lines = page.body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```console/.test(lines[i])) continue;
    const close = lines.findIndex((l, j) => j > i && /^\s*```\s*$/.test(l));
    const block = lines.slice(i + 1, close < 0 ? lines.length : close);
    const marked = /^<!-- example: examples\/cli\//.test(lines[i - 1] ?? '');
    if (!marked && block.some((l) => /^\s*\$ caitlyn(\s|$)/.test(l))) out.push(`line ${i + 1}: a console block with a caitlyn command that no example runs; take it from examples/cli/ with an example marker, or write it as an sh block`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ llms files

/**
 * /cli/llms.txt (every CLI page with a one-line description, the reference included) and /cli/llms-full.txt (the
 * hand-written pages in full, not the reference), with any budget they are over. `entries` are the build's
 * { page, markdown, path } for every CLI page; `describe` gives a page's one-line description.
 */
export function llmsFiles(entries, { base = SITE, describe = (p) => p.description ?? '', order = (e) => e } = {}) {
  const url = (e) => `${base}/${e.path}`;
  const line = (e) => `- [${e.page.title}](${url(e)}): ${describe(e.page)}`;
  const handWritten = order(entries.filter((e) => e.page.source !== TREE_FILE));
  const tables = entries.filter((e) => e.page.source === TREE_FILE && !e.page.cliPath && e.page.slug !== 'cli/reference');
  const reference = entries.filter((e) => e.page.slug === 'cli/reference' || e.page.cliPath);
  const visible = reference.filter((e) => !e.page.hidden);
  const hidden = reference.filter((e) => e.page.hidden);
  const index = [
    '# Caitlyn CLI',
    '',
    '> `caitlyn`, the command-line tool for Caitlyn: agents, knowledge bases, chat, configuration as code and CI. It is',
    '> in preview: its commands, flags and output may still change. Every page is Markdown at its address with `.md` in',
    '> place of the trailing slash. The installed CLI describes itself too:',
    '> `caitlyn commands --json` (every command) and `caitlyn help <command> --format markdown|json` (one command).',
    '',
    '## Start here',
    '',
    ...handWritten.map(line),
    '',
    '## Reference tables',
    '',
    ...tables.map(line),
    '',
    '## Command reference',
    '',
    ...visible.map(line),
    '',
    '## Optional',
    '',
    ...hidden.map(line),
    `- [The CLI in one file](${base}/cli/llms-full.txt): every page under Start here and Reference tables, in full`,
    `- [The whole site](${base}/llms.txt): the SDKs, the HTTP API and every guide`,
    '',
  ].join('\n');
  const full = [...handWritten, ...tables].map((e) => `<!-- ${base}/${e.page.slug}/ -->\n${e.markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, '')}`).join('\n');
  const problems = [];
  if (tokens(index) > LLMS_BUDGET) problems.push(`/cli/llms.txt is about ${tokens(index)} tokens, over its budget of ${LLMS_BUDGET}`);
  if (tokens(full) > LLMS_FULL_BUDGET) problems.push(`/cli/llms-full.txt is about ${tokens(full)} tokens, over its budget of ${LLMS_FULL_BUDGET}`);
  for (const e of entries) if (!index.includes(`(${url(e)})`)) problems.push(`/cli/llms.txt does not list ${e.page.slug}`);
  return { index, full, problems };
}

export { kebab };
