// The esbuild plugins behind the package builds (scripts/build-packages.mjs), shared with the conformance runs
// (scripts/build-conformance.mjs and scripts/conformance-browser.mjs), which compile the same sources the same way.
//
// - The generated SDK's @smithy/* imports go to sdk-core's runtime (packages/sdk-core/src/runtime/smithy.ts), in
//   every build.
// - The browser build of sdk-core leaves out the sign-in modes a browser may not use, the AWS signer and the file system
//   (src/browser/auth-server.ts, aws.ts and files-node.ts in place of src/auth-server.ts, aws.ts and files-node.ts).
import path from 'node:path';

// The TypeScript workspace to build: this checkout's typescript/ by default, or CAITLYN_TS_ROOT, another laid out the
// same way (scripts/dev-sdk.sh's, under build/dev-sdk/<name>/typescript).
const root = process.env.CAITLYN_TS_ROOT ? path.resolve(process.env.CAITLYN_TS_ROOT) : path.resolve(import.meta.dirname, '..');
export const coreSrc = path.join(root, 'packages/sdk-core/src');
const sdkSrc = path.join(root, 'packages/sdk/src');
const runtimeBarrel = path.join(coreSrc, 'runtime/smithy.ts');
const isSdkSource = (dir) => dir === sdkSrc || dir.startsWith(`${sdkSrc}${path.sep}`);
const SMITHY = /^@smithy\//;
/** The generated SDK's @smithy/* imports, which all go to sdk-core's runtime. */
const toRuntime = (a) => isSdkSource(a.resolveDir);

/** The generated runtimeConfig for fetch: the edge and browser builds. */
export const fetchRuntimeConfig = {
  name: 'fetch-runtime-config',
  setup(b) {
    b.onResolve({ filter: /^\.\/runtimeConfig$/ }, (a) => ({ path: path.join(a.resolveDir, 'runtimeConfig.browser.ts') }));
  },
};

/**
 * sdk-core's edge build (Cloudflare Workers, Vercel Edge, Deno, web workers): no file system, so the file helpers
 * take Blobs, bytes and streams (src/browser/files-node.ts in place of src/files-node.ts); everything else is the
 * Node build's.
 */
export const coreEdge = {
  name: 'sdk-core-edge',
  setup(b) {
    b.onResolve({ filter: /^\.\/files-node\.js$/ }, (a) => (a.resolveDir === coreSrc ? { path: path.join(coreSrc, 'browser', 'files-node.ts') } : undefined));
  },
};

/** sdk-core's browser build: no server-only sign-in modes, no AWS signer. */
export const coreBrowser = {
  name: 'sdk-core-browser',
  setup(b) {
    b.onResolve({ filter: /^\.\/(auth-server|aws|files-node)\.js$/ }, (a) =>
      a.resolveDir === coreSrc ? { path: path.join(coreSrc, 'browser', a.path.replace(/\.js$/, '.ts')) } : undefined,
    );
  },
};

/** The SDK's builds: its @smithy/* imports from sdk-core's runtime, as a package import. */
export const sdkRuntime = (browser = false) => ({
  name: 'sdk-runtime',
  setup(b) {
    b.onResolve({ filter: SMITHY }, (a) => (toRuntime(a) ? { path: browser ? '@caitlyn-ai/sdk-core/browser/smithy' : '@caitlyn-ai/sdk-core/smithy', external: true } : undefined));
    if (browser) b.onResolve({ filter: /^@caitlyn-ai\/sdk-core$/ }, () => ({ path: '@caitlyn-ai/sdk-core/browser', external: true }));
  },
});

/** The SDK compiled from source in one bundle, for the conformance runs: the generated code on sdk-core's runtime. */
export const runtimeFromSource = {
  name: 'runtime-from-source',
  setup(b) {
    b.onResolve({ filter: SMITHY }, (a) => (toRuntime(a) ? { path: runtimeBarrel } : undefined));
  },
};

/** As runtimeFromSource, for the browser build: fetch, and sdk-core's browser stand-ins. */
export const browserFromSource = {
  name: 'browser-from-source',
  setup(b) {
    fetchRuntimeConfig.setup(b);
    coreBrowser.setup(b);
    runtimeFromSource.setup(b);
  },
};
