// The runtime half of @presignedUpload (PROTOCOL.md "Uploads"): checksum the bytes, reserve the slot,
// PUT the bytes to the presigned URL, in a `caitlyn.upload` span (PROTOCOL.md 13).
import { SpanKind, SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { recordFailure, urlWithoutQuery } from './telemetry.js';
const STATUS = Symbol('status');

export interface UploadSlot {
  uploadUrl: string;
  uploadMethod: string;
  requiredHeaders: Record<string, string>;
}

export interface UploadMeta {
  fileName: string;
  contentType: string;
  byteSize: number;
  sha256: string;
}

export async function uploadFile<S extends UploadSlot>(
  file: Blob,
  fileName: string,
  reserve: (meta: UploadMeta) => Promise<S>,
  toError: (problem: Record<string, unknown>) => Error,
  signal?: AbortSignal,
  tracer?: Tracer,
): Promise<S> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  const slot = await reserve({ fileName, contentType: file.type || 'application/octet-stream', byteSize: bytes.byteLength, sha256: btoa(binary) });
  const put = async () => {
    const res = await fetch(slot.uploadUrl, { method: slot.uploadMethod, headers: slot.requiredHeaders, body: bytes, signal });
    if (!res.ok) throw Object.assign(toError({ status: res.status, code: 'UPLOAD_PUT_FAILED', title: 'Uploading the bytes failed', detail: await res.text() }), { [STATUS]: res.status });
    return res.status;
  };
  if (!tracer) {
    await put();
    return slot;
  }
  const url = new URL(slot.uploadUrl);
  const span = tracer.startSpan('caitlyn.upload', {
    kind: SpanKind.CLIENT,
    attributes: { 'http.request.method': slot.uploadMethod || 'PUT', 'server.address': url.hostname, 'url.full': urlWithoutQuery(slot.uploadUrl) },
  });
  try {
    span.setAttribute('http.response.status_code', await put());
    return slot;
  } catch (err) {
    const status = (err as { [STATUS]?: number })[STATUS];
    if (status !== undefined) span.setAttribute('http.response.status_code', status);
    recordFailure(span, err);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}
