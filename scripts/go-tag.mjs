// Tags a release for Go: creates go/vX.Y.Z on the commit vX.Y.Z points at.
//
//   node scripts/go-tag.mjs <version>    such as 0.8.0 (a leading v is accepted)
//
// The Go module is github.com/caitlyn-ai/sdk/go, in this repository's go/ subdirectory. Go finds a version of a
// module in a subdirectory by a tag with the subdirectory as its prefix (https://go.dev/ref/mod#vcs-version), so
// `go get github.com/caitlyn-ai/sdk/go@v0.9.0` resolves the tag go/v0.9.0, not v0.9.0. The release commit already
// carries the version in go/version.go, so the Go tag goes on that same commit; nothing is built.
//
// It refuses a release whose go/go.mod declares another module path: Go rejects a version whose go.mod names a
// different module, so a go/ tag there would only be a broken version nobody can remove from the module proxy. Every
// release up to v0.8.0 declares github.com/caitlyn-ai/caitlyn-go, so the first Go release is the first one after
// the module moved to github.com/caitlyn-ai/sdk/go.
//
// semantic-release runs this after it pushes vX.Y.Z (.releaserc.yml, publishCmd), and the `release:go` job runs it
// by hand for a release whose Go tag failed (CONTRIBUTING.md, "Go"). It creates the tag
// through the GitLab API with GITLAB_TOKEN (the release job's project access token, Maintainer, which may create
// the protected go/v* tags), and the push mirror takes it to github.com/caitlyn-ai/sdk.
//
// Running it again is safe: a go/ tag already on the right commit is left alone, and one on another commit fails.
const arg = process.argv[2] ?? '';
const version = arg.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`usage: node scripts/go-tag.mjs <version>, such as 0.8.0 (got "${arg}")`);
  process.exit(2);
}
const { GITLAB_TOKEN, CI_API_V4_URL, CI_PROJECT_ID } = process.env;
for (const [name, value] of Object.entries({ GITLAB_TOKEN, CI_API_V4_URL, CI_PROJECT_ID })) {
  if (!value) {
    console.error(`${name} is not set: this runs in CI, with the release job's GITLAB_TOKEN`);
    process.exit(2);
  }
}

const tags = `${CI_API_V4_URL}/projects/${encodeURIComponent(CI_PROJECT_ID)}/repository/tags`;
const headers = { 'PRIVATE-TOKEN': GITLAB_TOKEN };

async function getTag(name) {
  const res = await fetch(`${tags}/${encodeURIComponent(name)}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET tag ${name}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const release = await getTag(`v${version}`);
if (!release) {
  console.error(`There is no release tag v${version}.`);
  process.exit(1);
}
const commit = release.commit.id;
const goTag = `go/v${version}`;

const MODULE = 'github.com/caitlyn-ai/sdk/go';
const goMod = await fetch(
  `${CI_API_V4_URL}/projects/${encodeURIComponent(CI_PROJECT_ID)}/repository/files/${encodeURIComponent('go/go.mod')}/raw?ref=${commit}`,
  { headers },
);
if (!goMod.ok) {
  console.error(`Reading go/go.mod at v${version}: HTTP ${goMod.status}`);
  process.exit(1);
}
const declared = /^module\s+(\S+)\s*$/m.exec(await goMod.text())?.[1];
if (declared !== MODULE) {
  console.error(`v${version}'s go/go.mod declares module ${declared ?? '(none)'}, not ${MODULE}: ${goTag} would not resolve. Not tagging it.`);
  process.exit(1);
}

const existing = await getTag(goTag);
if (existing) {
  if (existing.commit.id === commit) {
    console.log(`${goTag} is already on ${commit}, with v${version}.`);
    process.exit(0);
  }
  console.error(`${goTag} is on ${existing.commit.id}, but v${version} is on ${commit}. Not changing it.`);
  process.exit(1);
}

const res = await fetch(tags, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tag_name: goTag,
    ref: commit,
    message: `github.com/caitlyn-ai/sdk/go v${version}`,
  }),
});
if (!res.ok) {
  console.error(`Creating ${goTag}: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`Tagged ${goTag} on ${commit}, with v${version}.`);
