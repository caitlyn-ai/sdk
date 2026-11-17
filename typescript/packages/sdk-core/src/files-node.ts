// What reading a file needs a file system or Node's crypto for (PROTOCOL.md 14): paths, streaming SHA-256, and
// spooling a one-shot stream to a temporary file. The browser build replaces this module with
// browser/files-node.ts, so no node: import reaches a page.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { open, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MEMORY_LIMIT = 8 * 1024 * 1024;

/** The standard-base64 SHA-256 of bytes in memory. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('base64');
}

/** The standard-base64 SHA-256 of a Blob, read as a stream (never whole in memory). */
export async function hashBlob(blob: Blob, signal?: AbortSignal): Promise<string> {
  const h = createHash('sha256');
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      h.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return h.digest('base64');
}

/** A file on disk: its size, the bytes as a file-backed Blob, its hash, and whether it changed since it was read. */
export interface PathFile {
  byteSize: number;
  blob: Blob;
  hash(): Promise<string>;
  changed(): Promise<boolean>;
}

export async function pathFile(file: string, signal?: AbortSignal): Promise<PathFile> {
  const before = await stat(file);
  if (!before.isFile()) throw new TypeError(`${file} is not a file`);
  return {
    byteSize: before.size,
    blob: await fs.openAsBlob(file),
    async hash() {
      const h = createHash('sha256');
      for await (const chunk of fs.createReadStream(file, { signal })) h.update(chunk as Buffer);
      return h.digest('base64');
    },
    async changed() {
      const now = await stat(file).catch(() => undefined);
      return !now || now.size !== before.size || now.mtimeMs !== before.mtimeMs;
    },
  };
}

/** A copy of a one-shot stream, made as it is hashed: in memory up to 8 MiB, then in a 0600 temporary file. */
export interface Spool {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<{ blob: Blob; sha256: string }>;
  dispose(): Promise<void>;
}

/** `hash` false copies the stream without hashing it (batch.upload); its sha256 is then empty. */
export function createSpool(contentType: string, hash = true): Spool {
  const h = createHash('sha256');
  let chunks: Uint8Array[] = [];
  let size = 0;
  let file: string | undefined;
  let handle: import('node:fs/promises').FileHandle | undefined;
  return {
    async write(chunk) {
      if (hash) h.update(chunk);
      size += chunk.byteLength;
      if (!handle && size <= MEMORY_LIMIT) {
        chunks.push(chunk);
        return;
      }
      if (!handle) {
        // Readable and writable by its owner only, and created new (never an existing file).
        file = path.join(os.tmpdir(), `caitlyn-upload-${randomUUID()}`);
        handle = await open(file, 'wx', 0o600);
        for (const c of chunks) await handle.write(c);
        chunks = [];
      }
      await handle.write(chunk);
    },
    async finish() {
      const sha256 = hash ? h.digest('base64') : '';
      if (!handle) return { blob: new Blob(chunks as BlobPart[], { type: contentType }), sha256 };
      await handle.close();
      handle = undefined;
      return { blob: await fs.openAsBlob(file!, { type: contentType }), sha256 };
    },
    async dispose() {
      await handle?.close().catch(() => {});
      handle = undefined;
      chunks = [];
      if (file) await unlink(file).catch(() => {});
      file = undefined;
    },
  };
}

/** A directory's files, for the ingest helper: relative paths with `/`, symbolic links not followed. */
export async function walkDirectory(dir: string): Promise<{ relativePath: string; absolutePath: string }[]> {
  const out: { relativePath: string; absolutePath: string }[] = [];
  const visit = async (rel: string) => {
    const entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await visit(r);
      else if (e.isFile()) out.push({ relativePath: r, absolutePath: path.join(dir, ...r.split('/')) });
    }
  };
  await visit('');
  return out;
}

/** A text file's contents, or undefined when there is none (a .caitlynignore). */
export async function readTextFile(file: string): Promise<string | undefined> {
  return fs.promises.readFile(file, 'utf8').catch(() => undefined);
}

export const joinPath = (...parts: string[]) => path.join(...parts);
