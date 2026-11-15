// Prints one version's section of CHANGELOG.md: the release notes semantic-release wrote for it
// (@semantic-release/changelog, .releaserc.yml). .github/workflows/release-github.yml uses it for the GitHub release.
//
//   node scripts/changelog-section.mjs <version> [file] [--github]
//
// <version> is 0.8.0 or v0.8.0; file defaults to CHANGELOG.md. A section starts at its version's heading ("# [0.8.0](…)",
// or "## [0.8.1](…)" for a patch) and ends before the next version's heading. It fails, printing nothing, when the
// file has no section for the version, so a caller can try another copy of the file.
//
// --github points the compare and commit links at the GitHub mirror instead of this GitLab: the mirror carries the same
// commits and tags, and a reader of a GitHub release may not be able to open git.customd.com. Other links are kept.
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
  section = section.replaceAll(
    /https:\/\/git\.customd\.com\/custom-d\/caitlyn\/sdk\/(?:-\/)?(compare|commit)\//g,
    'https://github.com/caitlyn-ai/sdk/$1/',
  );
}
process.stdout.write(`${section}\n`);
