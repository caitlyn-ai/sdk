// The runtime half of @presignedUpload (PROTOCOL.md "Uploads"): checksum the bytes, reserve the slot,
// PUT the bytes to the presigned URL.
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
): Promise<S> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  const slot = await reserve({ fileName, contentType: file.type || 'application/octet-stream', byteSize: bytes.byteLength, sha256: btoa(binary) });
  const res = await fetch(slot.uploadUrl, { method: slot.uploadMethod, headers: slot.requiredHeaders, body: bytes, signal });
  if (!res.ok) throw toError({ status: res.status, code: 'UPLOAD_PUT_FAILED', title: 'Uploading the bytes failed', detail: await res.text() });
  return slot;
}
