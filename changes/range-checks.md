---
type: feat
commit: c3b60ec0
summary: every SDK refuses a value outside its range before sending
---

- **No round trip for a request that cannot succeed:** a `limit` of 500 where the most is 100, or a `temperature`
  of 2 in an agent's configuration, now raises before anything is sent. See
  [Errors the SDK raises itself](/errors/#errors-the-sdk-raises-itself).
- **The same error as the server's:** it is the validation error a 400 raises, code `VALIDATION_FAILED`, with a
  field error naming the query parameter or the body value, and `status` 0. Code that already handles the server's
  refusal handles this one. See [VALIDATION_FAILED](/errors/VALIDATION_FAILED/).
