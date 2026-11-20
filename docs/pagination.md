---
pageType: concept
sinceVersion: 5000115000000
resources:
  - document
integrations: []
operations:
  - ListDocuments
---

# Pagination

A list operation returns its results a page at a time. Every list in every SDK can be read three ways:

- **Its items.** Iterate the list and each page is fetched when the loop reaches it, so a `break` stops fetching.
- **Its pages.** `pages()` (Go `ListPages`) yields each page, with its items and `nextCursor`.
- **One page.** `page()` (Go `ListPage`) is exactly one request. The page's `nextPage()` reads the page after it
  with the same input, and gives nothing on the last page without a request; `hasNextPage` says whether there is
  one. Keep the page's `nextCursor` for a position that outlives the page (a link, a reload): sent as `cursor`, it
  reads the same next page.

All three start from the `cursor` you give, or from the first page when you give none.

Cursors only go forward: there is no previous page. A screen that goes back keeps its own history of the cursors it
has used. Lists do not give a total count.

| | TypeScript | Python | Go | Rust |
| --- | --- | --- | --- | --- |
| One page | `list(…).page()` | `list(…).page()` | `ListPage(ctx, in)` | `list().page().await` |
| The next page | `page.nextPage()` | `page.next_page()`, or `await page.next_page_async()` on the async client | `page.NextPage(ctx)` | `page.next_page().await` |
| Is there one | `page.hasNextPage` | `page.has_next_page` | `page.HasNextPage()` | `page.has_next_page()` |

<!-- not-available -->

<!-- example: examples/typescript/concepts.ts#pagination -->
```ts tab="TypeScript"
// Every document in the folder: the next page is fetched as the loop reaches it
for await (const document of caitlyn.knowledgeBases('KB4T7YQ2WL').documents.list({ folder: '/policies/', limit: 100 })) {
  console.log(document.name, document.status);
}

// Or page by page
for await (const page of caitlyn.knowledgeBases('KB4T7YQ2WL').documents.list({ limit: 100 }).pages()) {
  console.log(page.items.length, page.nextCursor);
}

// Or one page at a time, as a table shows them
const documents = caitlyn.knowledgeBases('KB4T7YQ2WL').documents;
const first = await documents.list({ limit: 25 }).page();
const second = await first.nextPage(); // null on the last page
console.log(first.hasNextPage, second?.items.length);
// Later, from a stored position: the same page as `second`
if (first.nextCursor) await documents.list({ limit: 25, cursor: first.nextCursor }).page();
```
<!-- example: examples/python/concepts.py#pagination -->
```python tab="Python"
# Every document in the folder: the next page is fetched as the loop reaches it
for document in caitlyn.knowledge_bases("KB4T7YQ2WL").documents.list(folder="/hr/", limit=100):
    print(document.name, document.status)

# Or page by page
for page in caitlyn.knowledge_bases("KB4T7YQ2WL").documents.list(limit=100).pages():
    print(len(page.items), page.next_cursor)

# Or one page at a time, as a table shows them
documents = caitlyn.knowledge_bases("KB4T7YQ2WL").documents
first = documents.list(limit=25).page()
second = first.next_page()  # None on the last page
print(first.has_next_page, second and len(second.items))
# Later, from a stored position: the same page as `second`
if first.next_cursor:
    documents.list(limit=25, cursor=first.next_cursor).page()
```
<!-- example: examples/go/concepts/concepts.go#pagination -->
```go tab="Go"
// Every document in the folder: the next page is fetched as the loop reaches it
documents := client.KnowledgeBase("KB4T7YQ2WL").Documents
input := &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/hr/"), Limit: caitlyn.Ptr[int32](100)}
for document, err := range documents.List(ctx, input) {
	if err != nil {
		return err
	}
	fmt.Println(document.Name, document.Status)
}

// Or page by page
for page, err := range documents.ListPages(ctx, input) {
	if err != nil {
		return err
	}
	fmt.Println(len(page.Items), page.NextCursor)
}

// Or one page at a time, as a table shows them
first, err := documents.ListPage(ctx, &caitlyn.ListDocumentsInput{Limit: caitlyn.Ptr[int32](25)})
if err != nil {
	return err
}
second, err := first.NextPage(ctx) // nil on the last page
if err != nil {
	return err
}
fmt.Println(first.HasNextPage(), second != nil)
// Later, from a stored position: the same page as second
if first.HasNextPage() {
	if _, err := documents.ListPage(ctx, &caitlyn.ListDocumentsInput{Limit: caitlyn.Ptr[int32](25), Cursor: first.NextCursor}); err != nil {
		return err
	}
}
```
<!-- example: examples/rust/src/concepts.rs#pagination -->
```rust tab="Rust"
// Every document in the folder: the next page is fetched as the loop reaches it
let list = client
    .knowledge_base("KB4T7YQ2WL")
    .documents()
    .list()
    .folder("/hr/")
    .limit(100);
let mut documents = list.clone().items();
while let Some(document) = documents.next().await {
    let document = document?;
    println!("{} {:?}", document.name, document.status);
}

// Or page by page
let mut pages = list.pages();
while let Some(page) = pages.next().await {
    let page = page?;
    println!("{} {:?}", page.items.len(), page.next_cursor);
}

// Or one page at a time, as a table shows them
let documents = client.knowledge_base("KB4T7YQ2WL").documents();
let first = documents.list().limit(25).page().await?;
let second = first.next_page().await?; // None on the last page
println!("{} {}", first.has_next_page(), second.is_some());
// Later, from a stored position: the same page as `second`
if let Some(cursor) = first.next_cursor.clone() {
    documents.list().limit(25).cursor(cursor).page().await?;
}
```

## On the wire

Each page is a request with `limit` (how many items to return, up to the operation's maximum) and, after the
first page, `cursor`. The response has `items` and `nextCursor`; the last page has no `nextCursor`.

- **The order is stable.** Items come in an order that does not change between pages, so nothing is skipped or
  repeated while you page.
- **A cursor belongs to its list.** Use it only with the same operation, filters and sort; anything else is
  refused with [`INVALID_CURSOR`](/errors/INVALID_CURSOR/).
- **Filters and sorting** are the operation's own, listed on its reference page. A filter or sort field it does
  not declare is refused ([`UNKNOWN_FILTER`](/errors/UNKNOWN_FILTER/), [`UNKNOWN_SORT`](/errors/UNKNOWN_SORT/))
  rather than ignored.
