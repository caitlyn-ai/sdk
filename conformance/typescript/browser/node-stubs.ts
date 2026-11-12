// The Node modules the conformance harness imports, for a browser page. The harness reads three repository files
// (embedded at build time as `caitlyn:files`); the mock server is started by the runner, not by the harness; and the
// cases that need a file system or a socket are skipped in a page (NOT_IN_A_PAGE in the harness).
import files from 'caitlyn:files';

const unavailable = (what: string) => () => {
  throw new Error(`${what} is not available in a browser page`);
};

export const fs = {
  readFileSync(p: string): string {
    const hit = Object.entries(files as Record<string, string>).find(([suffix]) => p.endsWith(suffix));
    if (!hit) throw new Error(`no embedded file for ${p}`);
    return hit[1];
  },
  mkdtempSync: unavailable('fs.mkdtempSync'),
  writeFileSync: unavailable('fs.writeFileSync'),
};
export const path = { join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'), resolve: (...parts: string[]) => parts.join('/') };
export const os = { tmpdir: () => '/tmp' };
export const net = { createServer: unavailable('net.createServer') };
export const spawn = unavailable('child_process.spawn');
