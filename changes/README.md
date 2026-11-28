# Change files

Each merge request that changes what the SDKs do adds one file here. It becomes that change's entry in the release
notes: the next release's section of `CHANGELOG.md`, its GitLab and GitHub releases, and the
[Changelog](https://build.caitlyn.ai/changelog/) and its feed. Nobody writes notes at release time:
`scripts/release-notes.mjs` builds them from these files, the commits, and the model's changes since the last release.

A merge request needs one when its title makes a release: `feat`, `fix`, `perf` or `revert`, or any type with `!`.
A `docs` or `ci` scope needs none. The `changes:check` job says when one is missing or doesn't match the title.

A release happens if and only if a package changes (CONTRIBUTING.md, "What makes a release"), so the title must
agree with what the merge request changes, and `changes:check` holds it to that both ways:

- a releasing title that changes no package (`fix(docs): a typo`, `feat: a faster pipeline`) fails: use `docs`,
  `ci`, `chore`, `test`, `build` or `refactor`, and add no change file;
- a change to what a package is built from (`node scripts/package-inputs.mjs list`) under any other type fails:
  use `fix`, `feat` or `perf`, with a change file.

## The format

Name it after the change (`changes/list-pages.md`). Front matter, then a list of highlights:

```markdown
---
type: feat            # feat, fix, perf or revert: the title's type
scope: typescript     # optional: the title's scope, when it names one SDK or area
breaking: false       # true when the title has `!`; then a highlight says what to change
summary: one page of any list, and its pages, in every SDK
---

- **One page at a time:** `list(…).page()` makes one request from the input's `cursor` and returns its `items`,
  `nextCursor` and `hasNextPage`. See [Read one page](/pagination/#read-one-page).
- **Every page:** `list(…).pages()` yields every page from the cursor. See [Iterate the pages](/pagination/#iterate-the-pages).
```

- **summary** is the entry's first line: what changed, for someone using the SDKs, with no full stop.
- **Each highlight** starts with a bold lead (`**Lead:** `), says what you can now do and why it matters in a sentence
  or two, and ends by linking the page it is about: `See [Page](/page/).` Links are the site's own paths (they end in
  `/`, optionally with a `#heading`). They are made absolute in `CHANGELOG.md`, and the docs build fails on one that
  names no page or heading.
- The public-wording rules apply (`scripts/docs-wording.mjs`): no internal hosts, merge request numbers or
  model-author vocabulary.

A change that merged without its file can have one added later, by any merge request: add `commit: <hash>` to the
front matter, naming the commit it describes. The file takes that commit's line in the notes, and `changes:check`
checks it against that commit's title instead of the merge request's. The commit must be on `main` and not released
yet.

New operations, types, members and enum values are listed for you, from the model, with links to their reference
pages: don't repeat them here unless there is more to say about them.

## Previewing

A merge request's docs preview opens its Changelog with an **Unreleased** entry: what the next release's notes will say
once it merges, with its own entries marked "This merge request". Locally, `node scripts/release-notes.mjs unreleased`
prints the same section.

Files stay here after their release: a file belongs to the release whose range added it.
