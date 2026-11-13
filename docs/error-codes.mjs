// What each error code means and what to do about it: the hand-written part of each page in the error
// reference, https://build.caitlyn.ai/errors/{code} (the `type` of every error body). The status, the error
// class in each SDK and the operations that list the error come from the model (scripts/docs-reference.mjs).
// Every code in an error shape's @errorCodes needs an entry here, or the docs build fails.
export const ERROR_CODES = {
  VALIDATION_FAILED: {
    meaning: 'The request is malformed: a member is missing, has the wrong type or is out of range. On an update, it is also what a member that is both set and named in `clear`, or a `clear` entry that cannot be cleared, gets.',
    action: 'Read `errors` on the error: one entry per member or parameter at fault, with a JSON pointer to it, its own code and a description. Fix the request; sending it again unchanged fails the same way.',
  },
  UNKNOWN_FIELD: {
    meaning: 'The request has a member the operation does not define. v3 refuses unknown members rather than ignoring them, so a misspelt member is never silently dropped.',
    action: 'Check the member names against the operation\'s reference page. An SDK only sends members it knows, so this usually means a hand-built request, or a member newer than the server (the SDKs check that before sending; see [Versions](/getting-started/#versions-and-older-servers)).',
  },
  UNKNOWN_FILTER: {
    meaning: 'A list request has a filter, or a filter operator, the operation does not declare.',
    action: 'Use only the filters the operation\'s reference page lists. Unlike v2, an unknown filter is refused rather than ignored.',
  },
  UNKNOWN_SORT: {
    meaning: 'A list request asks to sort by a field the operation cannot sort by.',
    action: 'Use one of the sortable fields the operation\'s reference page lists, with a leading `-` for descending order.',
  },
  INVALID_CURSOR: {
    meaning: 'The `cursor` is not one this list returned, or it belongs to a different list or different filters.',
    action: 'Pass the `nextCursor` of the previous page of the same list, with the same filters and sort, or start again without a cursor. The SDKs\' list iterators handle cursors for you ([Pagination](/pagination/)).',
  },
  UNAUTHENTICATED: {
    meaning: 'No credential was sent, or it has expired or is not valid.',
    action: 'In the `clientCredentials`, `oauth`, `awsIam` and `workloadIdentity` sign-in modes, the SDKs get a new token and send the call once more before raising this. If you still get it, check the credential itself: a revoked personal access token, a rotated client secret, or an `oauth` refresh token that was refused (sign the person in again). See [Authentication](/authentication/).',
  },
  PERMISSION_DENIED: {
    meaning: 'The caller does not have the permission the operation needs, or its kind of credential may not call the operation (some operations are for people only, or not for guests).',
    action: 'The operation\'s reference page lists the permission and who may call it. Grant the permission to the person or API client, or give the API client a scope that includes it. A record the caller may not see is 404, not 403.',
  },
  NOT_AVAILABLE_TO_CREDENTIALS: {
    meaning: 'The operation issues or revokes credentials, so no token may call it: its permission belongs to no scope. A credential that could create credentials would escape its own revocation.',
    action: 'Do this in the Caitlyn app while signed in, not with a token.',
  },
  PRIMARY_WORKSPACE_REQUIRED: {
    meaning: "The operation acts on the whole organisation, and only the organisation's primary workspace serves it.",
    action: "Create the client for the organisation's primary workspace (its hostname) and call the operation there.",
  },
  NOT_FOUND: {
    meaning: 'The record does not exist, or the caller may not see it. The two are deliberately the same, so identifiers cannot be probed. For an agent version, it is also what someone without the agent\'s version access grant gets for the draft or a pinned version.',
    action: 'Check the identifier, and that the caller has access to the record (and, for the draft or a pinned version, the version access grant).',
  },
  CONFLICT: {
    meaning: "The resource's current state does not allow the request: for example, an upload that has already been used, or a message sent while an answer to the previous one is still being written.",
    action: '`detail` says what the conflict is. Wait for the other work to finish, or start from a fresh state (a new upload, for example), then try again.',
  },
  ALREADY_EXISTS: {
    meaning: 'A name that must be unique is already taken.',
    action: 'Choose another name, or fetch and use the record that already has it.',
  },
  IDEMPOTENCY_KEY_IN_USE: {
    meaning: 'A request with the same `Idempotency-Key` is still being processed.',
    action: 'Wait, then send the request again with the same key: once the first request has finished, the server answers with its result instead of acting twice.',
  },
  OPERATION_NOT_CANCELLABLE: {
    meaning: 'Cancelling an Operation (a long-running task, such as a document ingestion) that cannot be cancelled.',
    action: 'No operation in the API returns this code yet; it is reserved for cancelling Operations.',
  },
  PRECONDITION_FAILED: {
    meaning: "`If-Match` does not match the resource's current ETag: someone changed it after you read it.",
    action: 'Read the resource again, apply your change to what you read, and send it with the new ETag. Never retry with the old one.',
  },
  PAYLOAD_TOO_LARGE: {
    meaning: 'The body, a file or the `context` of a sent message is over its documented limit.',
    action: 'The limit is on the member\'s or operation\'s reference page. Send less: split the file, or trim the context.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    meaning: 'The `Idempotency-Key` was already used with a different request body.',
    action: 'Use a new key for a different request. The SDKs make a new key for every call and reuse it only for that call\'s retries, so this comes from passing your own key twice.',
  },
  PRECONDITION_REQUIRED: {
    meaning: 'The update sent no `If-Match` header.',
    action: 'Read the resource, then send its ETag with the update (TypeScript `{ ifMatch }`, Python `if_match=`, Go `caitlyn.WithIfMatch`, Rust `.if_match(…)`).',
  },
  RATE_LIMITED: {
    meaning: 'Too many requests.',
    action: 'Wait for `Retry-After` (on the error as `retryAfterSeconds`) and try again. The SDKs do this for operations that are safe to repeat, up to their attempt limit ([Retries](/retries/)).',
  },
  INTERNAL: {
    meaning: 'An unexpected failure in Caitlyn.',
    action: 'The SDKs do not retry it. Quote the `requestId` to Caitlyn support.',
  },
  SERVICE_UNAVAILABLE: {
    meaning: "A service Caitlyn depends on is briefly unavailable, or the request's audit event could not be recorded (Caitlyn refuses a write it cannot audit).",
    action: 'Wait for `Retry-After` (`retryAfterSeconds`) and try again. The SDKs do this for operations that are safe to repeat ([Retries](/retries/)).',
  },
};
