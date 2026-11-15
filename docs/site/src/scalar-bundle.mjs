// Where the site serves Scalar's standalone bundle (@scalar/api-reference), so the API reference loads nothing from
// a CDN. The version is in the path, so a new version is a new address and the old one can be cached for good.
// Read by astro.config.mjs, which passes the address to the page as SCALAR_BUNDLE.
import fs from 'node:fs';

const dir = new URL('../node_modules/@scalar/api-reference/', import.meta.url);
const { version } = JSON.parse(fs.readFileSync(new URL('package.json', dir), 'utf8'));

export const SCALAR_BUNDLE = `/_scalar/${version}/standalone.js`;
export const SCALAR_BUNDLE_FILE = new URL('dist/browser/standalone.js', dir);
