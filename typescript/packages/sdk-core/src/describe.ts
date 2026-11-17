// A file as an estimate describes it (the model's UploadDescription, PROTOCOL.md 10): `kb.documents.create.estimate(file)`,
// `doc.replace.estimate(file)` and kb.ingestion.sync.estimate send this in place of the file. Nothing is uploaded and
// nothing is hashed: a path is only looked at (its size), a Blob or bytes are measured, and a one-shot stream is read
// through to count it (unless its size is given).
//
// A caller may give the description itself in place of the file. The SDK's own carries the name, content type and size, and no `hints`: the server prices a file it knows
// only by its size as a typical one and says so (`documentsOfUnknownLength`). Reading hints as the Caitlyn app does
// (its PDF, Word and Markdown readers) would add about 8.4 KB gzipped to every browser bundle that includes the client.
import { UploadFile, contentTypeFor, isFileInput, measureStream, type FileInput, type PreparedFile, type ToError } from './files.js';
import { pathFile } from './files-node.js';

/** A file described for an estimate, before it is uploaded: what the SDK sends, or what a caller who knows more gives. */
export interface UploadDescription {
  name: string;
  contentType: string;
  byteSize: number;
  /** What a caller read of the file (pages, seconds of audio or video…): the model's IngestionHints. */
  hints?: Record<string, number>;
}

/** A description given in place of a file: a plain object with a name, a content type and a size. */
export function isUploadDescription(v: unknown): v is UploadDescription {
  return typeof v === 'object' && v !== null && !isFileInput(v) && typeof (v as UploadDescription).name === 'string'
    && typeof (v as UploadDescription).contentType === 'string' && typeof (v as UploadDescription).byteSize === 'number' && !('sha256' in v);
}

const isPrepared = (v: unknown): v is PreparedFile => typeof v === 'object' && v !== null && 'sha256' in v && 'blob' in v && 'byteSize' in v;

/**
 * Describes a file (or one already read, in kb.ingestion.sync) for an estimate. A description given in place of the
 * file is sent as it is, so a caller who has read the file's pages or length can give them as `hints`.
 */
export async function describeFile(file: FileInput | PreparedFile | UploadDescription, toError: ToError, signal?: AbortSignal): Promise<UploadDescription> {
  if (isUploadDescription(file)) return file;
  // The caller's hints go as they are (withHints, or UploadFileOptions.hints); a file given none has no `hints`.
  const described = (name: string, contentType: string, byteSize: number, hints?: Record<string, number>): UploadDescription =>
    hints ? { name, contentType, byteSize, hints } : { name, contentType, byteSize };
  if (isPrepared(file)) return described(file.name, file.contentType, file.byteSize, file.hints);
  const f = UploadFile.from(file);
  const src = f.source;
  const contentType = f.contentType ?? contentTypeFor(f.name);
  const byteSize =
    src.kind === 'path' ? (await pathFile(src.path, signal)).byteSize
    : src.kind === 'blob' ? src.blob.size
    : src.kind === 'bytes' ? src.bytes.byteLength
    // A one-shot stream has to be read to be measured: it is counted, never hashed or kept, unless its size is given.
    : src.size ?? (await measureStream(src.stream, signal));
  return described(f.name, contentType, byteSize, f.hints);
}
