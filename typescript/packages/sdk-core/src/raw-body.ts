// The text of an error body, as every Caitlyn error carries it (PROTOCOL.md 6.3). Shared by the Smithy-based
// protocol and the browser build's own.

/** The most of an error body kept as `rawBody` (PROTOCOL.md 6.3). */
export const RAW_BODY_LIMIT = 8192;

/** An error body as text: whole up to 8 KiB, else its first 8 KiB, cut back to a character boundary. */
export function rawBodyOf(bytes: Uint8Array): { rawBody: string; rawBodyTruncated: boolean } {
  if (bytes.byteLength <= RAW_BODY_LIMIT) return { rawBody: new TextDecoder().decode(bytes), rawBodyTruncated: false };
  let end = RAW_BODY_LIMIT;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--; // never split a UTF-8 sequence
  return { rawBody: new TextDecoder().decode(bytes.subarray(0, end)), rawBodyTruncated: true };
}

/** Whether a response body parses as a JSON object, the only body problem details can be read from. */
export function isJsonObject(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}
