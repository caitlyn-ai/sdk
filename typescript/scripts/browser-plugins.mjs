// The esbuild plugins that make the browser build (scripts/build-packages.mjs), shared with the browser
// conformance run (scripts/build-conformance.mjs --browser), which compiles the same sources the same way.
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
export const coreSrc = path.join(root, 'packages/sdk-core/src');
const browserDir = path.join(coreSrc, 'browser');
const packagesDir = path.join(root, 'packages');

/** The generated runtimeConfig for fetch: the edge and browser builds. */
export const fetchRuntimeConfig = {
  name: 'fetch-runtime-config',
  setup(b) {
    b.onResolve({ filter: /^\.\/runtimeConfig$/ }, (a) => ({ path: path.join(a.resolveDir, 'runtimeConfig.browser.ts') }));
  },
};

/**
 * sdk-core's browser build: browser/protocol.ts, browser/auth-server.ts and browser/aws.ts in place of the Node
 * build's, and every @smithy/* import through browser/smithy.ts (which itself imports the real packages).
 */
export const coreBrowser = {
  name: 'sdk-core-browser',
  setup(b) {
    b.onResolve({ filter: /^\.\/(protocol|auth-server|aws)\.js$/ }, (a) =>
      a.resolveDir === coreSrc ? { path: path.join(browserDir, a.path.replace(/\.js$/, '.ts')) } : undefined,
    );
    b.onResolve({ filter: /^@smithy\// }, (a) => (a.resolveDir === browserDir ? { path: a.path, external: true } : { path: path.join(browserDir, 'smithy.ts') }));
  },
};

/** The SDK's browser build: sdk-core's browser entries, and its Smithy runtime, as package imports. */
export const sdkBrowser = {
  name: 'sdk-browser',
  setup(b) {
    b.onResolve({ filter: /^@smithy\// }, () => ({ path: '@caitlyn-ai/sdk-core/smithy', external: true }));
    b.onResolve({ filter: /^@caitlyn-ai\/sdk-core$/ }, () => ({ path: '@caitlyn-ai/sdk-core/browser', external: true }));
  },
};

/**
 * The browser build compiled from source in one bundle, for tests: the SDK's and sdk-core's sources with the
 * plugins above, and the real @smithy/* packages behind browser/smithy.ts.
 */
export const browserFromSource = {
  name: 'browser-from-source',
  setup(b) {
    b.onResolve({ filter: /^\.\/runtimeConfig$/ }, (a) => ({ path: path.join(a.resolveDir, 'runtimeConfig.browser.ts') }));
    b.onResolve({ filter: /^\.\/(protocol|auth-server|aws)\.js$/ }, (a) =>
      a.resolveDir === coreSrc ? { path: path.join(browserDir, a.path.replace(/\.js$/, '.ts')) } : undefined,
    );
    // Only the SDK's own imports: the Smithy packages' imports of each other stay as they are.
    b.onResolve({ filter: /^@smithy\// }, (a) =>
      a.resolveDir !== browserDir && a.resolveDir.startsWith(packagesDir) && !a.resolveDir.includes('node_modules') ? { path: path.join(browserDir, 'smithy.ts') } : undefined,
    );
  },
};
