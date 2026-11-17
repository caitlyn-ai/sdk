// Every weight the site's stylesheets ask of the body font has a face to draw it: a web face (Euclid Circular, served
// by the hosting) or, for the one weight with no web file, a documented fall to the nearest one; and the local
// fallback family covers every weight too, so emphasis survives before the web font arrives and wherever it is not
// served. A weight with no face is drawn in the nearest one, so emphasis at 500 in a family with only 400 looks like
// body text, and 600 or more in a family without it is synthesised. Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const STYLES = ['caitlyn.css', 'custom.css', 'components.css'].map((f) => [f, fs.readFileSync(new URL(`../src/styles/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')]);
// Weights the body font is asked for with no web face of their own, and why that is accepted
const NO_WEB_FACE = { 300: 'Light: the body token weight; only Regular and Medium have web files, so it draws in Regular (caitlyn.css)' };
// Rules whose text is set in the code font (ui-monospace, from the strip or tabs that contain them), which has its own bold
const CODE_FONT = ['.caitlyn-http-method', ".caitlyn-op-status-tabs .caitlyn-status[aria-selected='true']"];

/** Each rule as { file, selector, body }, innermost blocks only (an @media block's rules, not the @media itself). */
const rules = () => STYLES.flatMap(([file, css]) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ file, selector: m[1].trim(), body: m[2] })));
const WEIGHT = { normal: 400, bold: 700 };
/** The weights a face covers: "400", or a range "500 700" */
const range = (v) => {
  const [a, b = a] = v.trim().split(/\s+/).map((x) => WEIGHT[x] ?? Number(x));
  return [a, b];
};
const facesOf = (family) => rules().filter((r) => r.selector === '@font-face' && new RegExp(`font-family:\\s*'${family}'\\s*;`).test(r.body)).map((r) => range(/font-weight:\s*([^;]+);/.exec(r.body)?.[1] ?? 'normal'));
const covered = (faces, w) => faces.some(([a, b]) => w >= a && w <= b);

/** Every weight a rule sets on body-font text (not inherit, not in the code font) */
function askedWeights() {
  const out = new Map();
  for (const r of rules()) {
    if (r.selector.startsWith('@')) continue;
    const m = /(?:^|;)\s*font-weight:\s*([^;]+);/.exec(r.body);
    if (!m || /inherit|var\(/.test(m[1])) continue;
    if (/font-family:\s*var\(--__sl-font-mono/.test(r.body) || CODE_FONT.includes(r.selector)) continue;
    const w = WEIGHT[m[1].trim()] ?? Number(m[1]);
    out.set(w, [...(out.get(w) ?? []), `${r.file}: ${r.selector}`]);
  }
  return out;
}

test('the body font has its web faces and the fallback family covers every weight', () => {
  assert.deepEqual(facesOf('Euclid Circular'), [[400, 400], [500, 500]]);
  assert.ok(covered(facesOf('Euclid Circular Fallback'), 500), 'the fallback has a face for Medium');
});

test('every weight the stylesheets ask of the body font has a face, in the web font and in its fallback', () => {
  const web = facesOf('Euclid Circular');
  const fallback = facesOf('Euclid Circular Fallback');
  const asked = askedWeights();
  assert.ok(asked.has(500) && asked.has(300), 'reads the weights the stylesheets set');
  for (const [w, where] of asked) {
    assert.ok(covered(web, w) || NO_WEB_FACE[w], `font-weight ${w} has no Euclid Circular face: ${where.slice(0, 3).join('; ')}`);
    assert.ok(covered(fallback, w), `font-weight ${w} has no Euclid Circular Fallback face: ${where.slice(0, 3).join('; ')}`);
  }
});

test('the two web faces load early, as their @font-face rules name them', () => {
  const config = fs.readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8');
  const css = STYLES[0][1];
  for (const [, file] of css.matchAll(/url\('\/_fonts\/v1\/([^']+\.woff2)'\)/g)) assert.ok(config.includes(`'${file}'`), `${file} is preloaded`);
});
