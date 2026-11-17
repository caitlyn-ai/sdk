// The browser build's stand-in for ../files-node.ts (PROTOCOL.md 14): a page has no file system, so a path is
// refused, the SHA-256 comes from Web Crypto over the whole file (as the Caitlyn app does), and a one-shot stream is
// spooled to a Blob, which the browser keeps in memory or on disk as it sees fit.
import type { PathFile, Spool } from '../files-node.js';

export type { PathFile, Spool };

const toBase64 = (digest: ArrayBuffer) => {
  let binary = '';
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary);
};

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  return toBase64(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

export async function hashBlob(blob: Blob): Promise<string> {
  return toBase64(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
}

const noFiles = (what: string) => new TypeError(`${what} needs a file system, which the browser build does not have: pass a File, a Blob, bytes or a stream`);

export async function pathFile(file: string): Promise<PathFile> {
  throw noFiles(`The path ${file}`);
}

/** `hash` false copies the stream without hashing it (batch.upload); its sha256 is then empty. */
export function createSpool(contentType: string, hash = true): Spool {
  let chunks: Uint8Array[] = [];
  return {
    async write(chunk) {
      chunks.push(chunk);
    },
    async finish() {
      const blob = new Blob(chunks as BlobPart[], { type: contentType });
      chunks = [];
      return { blob, sha256: hash ? await hashBlob(blob) : '' };
    },
    async dispose() {
      chunks = [];
    },
  };
}

export async function walkDirectory(dir: string): Promise<{ relativePath: string; absolutePath: string }[]> {
  throw noFiles(`The folder ${dir}`);
}

export async function readTextFile(): Promise<string | undefined> {
  return undefined;
}

export const joinPath = (...parts: string[]) => parts.join('/');
