// Prints one version's section of CHANGELOG.md: the release notes semantic-release wrote for it
// (@semantic-release/changelog, .releaserc.yml). .github/workflows/release-github.yml uses it for the GitHub release.
//
//   node scripts/changelog-section.mjs <version> [file] [--github]
//
// <version> is 0.8.0 or v0.8.0; file defaults to CHANGELOG.md. A section starts at its version's heading ("# [0.8.0](…)",
// or "## [0.8.1](…)" for a patch) and ends before the next version's heading. Exit codes, with nothing printed on
// failure: 1 when the file has no section for the version, so a caller can try another copy of the file; 2 for bad
// arguments; 3 when --github finds a link it cannot make public.
//
// --github is for text the public reads (the GitHub releases). semantic-release already writes the GitHub mirror's
// links (.releaserc.yml), so this is a safety net: any link still under this GitLab's repository
// (https://git.customd.com/custom-d/caitlyn/sdk/, with or without GitLab's /-/) is pointed at the same path on
// https://github.com/caitlyn-ai/sdk/, which has the same commits and tags, and any other git.customd.com address left
// fails the run instead of reaching the public.
import fs from 'node:fs';

const args = process.argv.slice(2);
const github = args.includes('--github');
const [given, file = 'CHANGELOG.md'] = args.filter((a) => a !== '--github');
const version = (given ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/changelog-section.mjs <version> [file] [--github], such as 0.8.0');
  process.exit(2);
}

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (err) {
  console.error(`${file}: ${err.message}`);
  process.exit(1);
}

// A version heading: "# [0.8.0](link) (date)", "## [0.8.1](link) (date)", or without a link, "# 0.1.0 (date)".
const heading = /^#{1,2} \[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?[ (]/;
const lines = text.split('\n');
const start = lines.findIndex((line) => heading.exec(line)?.[1] === version);
if (start === -1) {
  console.error(`${file} has no section for ${version}.`);
  process.exit(1);
}
let end = lines.findIndex((line, i) => i > start && heading.test(line));
if (end === -1) end = lines.length;

let section = lines.slice(start, end).join('\n').trim();
if (github) {
  section = section.replaceAll(/https?:\/\/git\.customd\.com\/custom-d\/caitlyn\/sdk\/(?:-\/)?/g, 'https://github.com/caitlyn-ai/sdk/');
  const left = section.match(/\S*git\.customd\.com\S*/gi);
  if (left) {
    console.error(`${file}'s ${version} section still names git.customd.com, which is not public: ${left.join(', ')}`);
    process.exit(3);
  }
}
process.stdout.write(`${section}\n`);
