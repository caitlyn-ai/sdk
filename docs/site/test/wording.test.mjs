// The public-wording check (scripts/docs-wording.mjs) flags areas, permissions and tools only Caitlyn's own staff have,
// and leaves the reader's own (a browser's developer tools, their administrator, Caitlyn support by email) alone.
// Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineProblems } from '../../../scripts/docs-wording.mjs';
import { readPages } from '../../../scripts/docs-guides.mjs';

test('an internal-only area or tool is flagged', () => {
  for (const line of [
    'It can never hold the **Developer tools** area, which can switch off document access control.',
    'The Developer tools area is for Caitlyn staff.',
    'Grant the developer-tools scope.',
    'This permission is support-only.',
    'Open the support console to reset it.',
    'Use the break-glass account.',
  ]) assert.ok(lineProblems(line).some((p) => /internal-only/.test(p)), line);
});

test('the reader\'s own tools and people are not flagged', () => {
  for (const line of [
    "Open the browser's developer tools and look at the console.",
    'Ask your Caitlyn administrator to add each website.',
    'Quote the requestId to Caitlyn support.',
    'People who manage Caitlyn settings have access to the admin panel.',
  ]) assert.deepEqual(lineProblems(line).filter((p) => /internal-only/.test(p)), [], line);
});

test('no hand-written page names an internal-only area or tool', () => {
  for (const page of readPages()) {
    let fence = false;
    for (const line of page.markdown.split('\n')) {
      if (/^\s*```/.test(line)) fence = !fence;
      if (!fence) assert.deepEqual(lineProblems(line).filter((p) => /internal-only/.test(p)), [], `${page.file}: ${line.trim()}`);
    }
  }
});
