---
type: feat
summary: one page of any list, and its pages, in every SDK
---

- **One page at a time:** `list(…).page()` makes one request from the input's `cursor` and returns its `items`, `nextCursor` and `hasNextPage`, so a table can show a page without reading the ones before it. See [Read one page](/pagination/#read-one-page).
- **The next page:** `page.nextPage()` reads the page after it with the same input, and on the last page gives nothing without a request. See [Read the next page](/pagination/#read-the-next-page).
- **Every page:** `list(…).pages()` yields every page from the cursor, and iterating the list still yields every item, so existing loops are unchanged. See [Iterate the pages](/pagination/#iterate-the-pages).
- **TypeScript keeps the cursor:** a TypeScript list is now `Paginated`, which no longer throws `nextCursor` away. See [Carry on from a cursor](/pagination/#carry-on-from-a-cursor).
