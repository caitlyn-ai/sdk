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

Every list in the API returns its results a page at a time, and every SDK reads every list the same way. Whether you
list documents, agents, conversations or anything else, you can:

- [**Iterate the items**](#iterate-the-items): every item, one at a time. The SDK fetches each page as your loop
  reaches it. Use this to process a whole list.
- [**Iterate the pages**](#iterate-the-pages): every page, one at a time, each with its items. Use this for work done
  a batch at a time.
- [**Read one page**](#read-one-page): exactly one request. Use this for a screen or an API of your own that shows a
  page at a time.
- [**Read the next page**](#read-the-next-page): from a page you have, whether there is a next one and the page
  after it. Use this for a "Next" button.
- [**Carry on from a cursor**](#carry-on-from-a-cursor): a page's position, saved and sent back later. Use this when
  the position outlives the page: a link, a reload, a job that resumes.

Then [how filters, limits and cursors work together](#filters-limits-and-cursors) on every list.

<!-- not-available -->

## Iterate the items

Iterating a list gives you its items: one `Document`, one `Agent`, never a page. The SDK requests the first page, hands
you its items in order, and requests the next page only when your loop has used them all. So stopping the loop early
(`break`) stops the requests too: you pay only for the pages you reach.

Choose this when you want everything that matches, or want to search the list and stop at the first match. It is the
simplest choice, and it never reads a page you do not use.

<!-- example: examples/typescript/concepts.ts#pagination-items -->
```ts tab="TypeScript"
// Every document in the folder, one at a time: the SDK fetches the next page when the loop reaches it
const documents = caitlyn.knowledgeBases('KB4T7YQ2WL').documents;
for await (const document of documents.list({ folder: '/policies/', limit: 100 })) {
  console.log(document.name, document.status);
  if (document.name === 'leave-policy.pdf') break; // stops here: no further page is requested
}
```
<!-- example: examples/python/concepts.py#pagination-items -->
```python tab="Python"
# Every document in the folder, one at a time: the SDK fetches the next page when the loop reaches it
documents = caitlyn.knowledge_bases("KB4T7YQ2WL").documents
for document in documents.list(folder="/policies/", limit=100):
    print(document.name, document.status)
    if document.name == "leave-policy.pdf":
        break  # stops here: no further page is requested
```
<!-- example: examples/go/concepts/concepts.go#pagination-items -->
```go tab="Go"
// Every document in the folder, one at a time: the SDK fetches the next page when the loop reaches it
documents := client.KnowledgeBase("KB4T7YQ2WL").Documents
input := &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Limit: caitlyn.Ptr[int32](100)}
for document, err := range documents.List(ctx, input) {
	if err != nil {
		return err
	}
	fmt.Println(document.Name, document.Status)
	if document.Name == "leave-policy.pdf" {
		break // stops here: no further page is requested
	}
}
```
<!-- example: examples/rust/src/concepts.rs#pagination-items -->
```rust tab="Rust"
// Every document in the folder, one at a time: the SDK fetches the next page when the loop reaches it
let documents = client.knowledge_base("KB4T7YQ2WL").documents();
let mut items = documents.list().folder("/policies/").limit(100).items();
while let Some(document) = items.next().await {
    let document = document?;
    println!("{} {:?}", document.name, document.status);
    if document.name == "leave-policy.pdf" {
        break; // stops here: no further page is requested
    }
}
```

## Iterate the pages

Iterating a list's pages gives you each page in turn: an object with `items` (that page's items) and `nextCursor`
(where the next page starts, absent on the last). The pages come one request at a time, as your loop asks for them.

Choose this when you work a batch at a time: writing each page to a database in one transaction, reporting progress
per page, or pausing between pages.

<!-- example: examples/typescript/concepts.ts#pagination-pages -->
```ts tab="TypeScript"
// Every page in turn, each with its items and nextCursor: for work done a batch at a time
const documents = caitlyn.knowledgeBases('KB4T7YQ2WL').documents;
for await (const page of documents.list({ folder: '/policies/', limit: 100 }).pages()) {
  console.log(`${page.items.length} documents; more to come: ${page.hasNextPage}`);
}
```
<!-- example: examples/python/concepts.py#pagination-pages -->
```python tab="Python"
# Every page in turn, each with its items and next_cursor: for work done a batch at a time
documents = caitlyn.knowledge_bases("KB4T7YQ2WL").documents
for page in documents.list(folder="/policies/", limit=100).pages():
    print(f"{len(page.items)} documents; more to come: {page.has_next_page}")
```
<!-- example: examples/go/concepts/concepts.go#pagination-pages -->
```go tab="Go"
// Every page in turn, each with its Items and NextCursor: for work done a batch at a time
documents := client.KnowledgeBase("KB4T7YQ2WL").Documents
input := &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Limit: caitlyn.Ptr[int32](100)}
for page, err := range documents.ListPages(ctx, input) {
	if err != nil {
		return err
	}
	fmt.Printf("%d documents; more to come: %v\n", len(page.Items), page.HasNextPage())
}
```
<!-- example: examples/rust/src/concepts.rs#pagination-pages -->
```rust tab="Rust"
// Every page in turn, each with its items and next_cursor: for work done a batch at a time
let documents = client.knowledge_base("KB4T7YQ2WL").documents();
let mut pages = documents.list().folder("/policies/").limit(100).pages();
while let Some(page) = pages.next().await {
    let page = page?;
    println!(
        "{} documents; more to come: {}",
        page.items.len(),
        page.has_next_page()
    );
}
```

## Read one page

Reading one page makes exactly one request and returns that page: its `items`, its `nextCursor`, and the two
helpers in the next section. It starts at the beginning of the list, or at the `cursor` you give it.

Choose this when something outside your code decides whether there is a next page: a person paging through a table,
or a caller of your own API that asks for one page at a time. It never reads more than you ask for.

<!-- example: examples/typescript/concepts.ts#pagination-page -->
```ts tab="TypeScript"
// One page, in exactly one request: the first 25 documents
const documents = caitlyn.knowledgeBases('KB4T7YQ2WL').documents;
const page = await documents.list({ folder: '/policies/', limit: 25 }).page();
for (const document of page.items) console.log(document.name);
console.log(page.nextCursor); // undefined on the last page
```
<!-- example: examples/python/concepts.py#pagination-page -->
```python tab="Python"
# One page, in exactly one request: the first 25 documents
documents = caitlyn.knowledge_bases("KB4T7YQ2WL").documents
page = documents.list(folder="/policies/", limit=25).page()
for document in page.items:
    print(document.name)
print(page.next_cursor)  # None on the last page
```
<!-- example: examples/go/concepts/concepts.go#pagination-page -->
```go tab="Go"
// One page, in exactly one request: the first 25 documents
documents := client.KnowledgeBase("KB4T7YQ2WL").Documents
page, err := documents.ListPage(ctx, &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Limit: caitlyn.Ptr[int32](25)})
if err != nil {
	return err
}
for _, document := range page.Items {
	fmt.Println(document.Name)
}
fmt.Println(page.NextCursor) // nil on the last page
```
<!-- example: examples/rust/src/concepts.rs#pagination-page -->
```rust tab="Rust"
// One page, in exactly one request: the first 25 documents
let documents = client.knowledge_base("KB4T7YQ2WL").documents();
let page = documents
    .list()
    .folder("/policies/")
    .limit(25)
    .page()
    .await?;
for document in &page.items {
    println!("{}", document.name);
}
println!("{:?}", page.next_cursor); // None on the last page
```

## Read the next page

Every page knows whether another page follows, and how to read it:

- `hasNextPage` says whether there is a next page. It reads the page you already have, so it makes no request: use it
  to show or hide a "Next" button.
- `nextPage()` reads the page after it, with the same input (the same filters, sort and `limit`), in one request.
  After the last page it gives nothing, and sends no request.

Show the first page, and the "Next" button only when there is a next page:

<!-- example: examples/typescript/concepts.ts#pagination-has-next-page -->
```ts tab="TypeScript"
// Show the first page, and a "Next" button only when another page follows: knowing that takes no request
const documents = caitlyn.knowledgeBases('KB4T7YQ2WL').documents;
let page = await documents.list({ folder: '/policies/', limit: 25 }).page();
render(page.items);
nextButton.hidden = !page.hasNextPage;
```
<!-- example: examples/python/concepts.py#pagination-has-next-page -->
```python tab="Python"
# Show the first page, and a "Next" button only when another page follows: knowing that takes no request
documents = caitlyn.knowledge_bases("KB4T7YQ2WL").documents
page = documents.list(folder="/policies/", limit=25).page()
render(page.items)
next_button["hidden"] = not page.has_next_page
```
<!-- example: examples/go/concepts/concepts.go#pagination-has-next-page -->
```go tab="Go"
// Show the first page, and a "Next" button only when another page follows: knowing that takes no request
documents := client.KnowledgeBase("KB4T7YQ2WL").Documents
page, err := documents.ListPage(ctx, &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Limit: caitlyn.Ptr[int32](25)})
if err != nil {
	return err
}
render(page.Items)
nextButtonHidden = !page.HasNextPage()
```
<!-- example: examples/rust/src/concepts.rs#pagination-has-next-page -->
```rust tab="Rust"
// Show the first page, and a "Next" button only when another page follows: knowing that takes no request
let documents = client.knowledge_base("KB4T7YQ2WL").documents();
let mut page = documents
    .list()
    .folder("/policies/")
    .limit(25)
    .page()
    .await?;
render(&page.items);
let mut next_button_hidden = !page.has_next_page();
```

Then, when the button is clicked, read the next page and show it in place of the one before:

<!-- example: examples/typescript/concepts.ts#pagination-next-page -->
```ts tab="TypeScript"
// The "Next" button's click handler: one request, for the page after the one shown
async function onNextClick(): Promise<void> {
  const next = await page.nextPage(); // null after the last page
  if (!next) return;
  page = next;
  render(page.items);
  nextButton.hidden = !page.hasNextPage;
}
```
<!-- example: examples/python/concepts.py#pagination-next-page -->
```python tab="Python"
# The "Next" button's click handler: one request, for the page after the one shown
def on_next_click() -> None:
    nonlocal page
    following = page.next_page()  # None after the last page; the asynchronous client's is await page.next_page_async()
    if following is None:
        return
    page = following
    render(page.items)
    next_button["hidden"] = not page.has_next_page
```
<!-- example: examples/go/concepts/concepts.go#pagination-next-page -->
```go tab="Go"
// The "Next" button's click handler: one request, for the page after the one shown
onNextClick := func() error {
	next, err := page.NextPage(ctx) // nil, nil after the last page
	if err != nil || next == nil {
		return err
	}
	page = next
	render(page.Items)
	nextButtonHidden = !page.HasNextPage()
	return nil
}
```
<!-- example: examples/rust/src/concepts.rs#pagination-next-page -->
```rust tab="Rust"
// When the "Next" button is clicked: one request, for the page after the one shown
if let Some(next) = page.next_page().await? {
    // None after the last page
    page = next;
    render(&page.items);
    next_button_hidden = !page.has_next_page();
}
```

There is no previous page: a cursor only goes forward. A screen with a "Previous" button keeps the pages, or the
cursors, it has already read. To read every page in turn, [iterate the pages](#iterate-the-pages) instead.

## Carry on from a cursor

A page's `nextCursor` is a string that marks where the next page starts. Send it back as `cursor`, with the same input
as before, and you get that page, from any process and at any later time. Keep it when the position must outlive the
page object: in a link's query string, across a reload, or in a job that stops and resumes.

`nextPage()` does this for you while you still have the page. Use the cursor when you do not.

<!-- example: examples/typescript/concepts.ts#pagination-cursor -->
```ts tab="TypeScript"
// Carry on from a position saved earlier (a link, a reload): the same input, and the cursor the page gave
const documents = caitlyn.knowledgeBases('KB4T7YQ2WL').documents;
const page = await documents.list({ folder: '/policies/', limit: 25, cursor }).page();
console.log(page.items.length, page.nextCursor); // save page.nextCursor to carry on from here next time
```
<!-- example: examples/python/concepts.py#pagination-cursor -->
```python tab="Python"
# Carry on from a position saved earlier (a link, a reload): the same input, and the cursor the page gave
documents = caitlyn.knowledge_bases("KB4T7YQ2WL").documents
page = documents.list(folder="/policies/", limit=25, cursor=cursor).page()
print(len(page.items), page.next_cursor)  # save page.next_cursor to carry on from here next time
```
<!-- example: examples/go/concepts/concepts.go#pagination-cursor -->
```go tab="Go"
// Carry on from a position saved earlier (a link, a reload): the same input, and the cursor the page gave
documents := client.KnowledgeBase("KB4T7YQ2WL").Documents
page, err := documents.ListPage(ctx, &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Limit: caitlyn.Ptr[int32](25), Cursor: cursor})
if err != nil {
	return err
}
fmt.Println(len(page.Items), page.NextCursor) // save page.NextCursor to carry on from here next time
```
<!-- example: examples/rust/src/concepts.rs#pagination-cursor -->
```rust tab="Rust"
// Carry on from a position saved earlier (a link, a reload): the same input, and the cursor the page gave
let documents = client.knowledge_base("KB4T7YQ2WL").documents();
let mut list = documents.list().folder("/policies/").limit(25);
if let Some(cursor) = cursor {
    list = list.cursor(cursor);
}
let page = list.page().await?;
println!("{} {:?}", page.items.len(), page.next_cursor); // save page.next_cursor to carry on from here next time
```

## Filters, limits and cursors

- **It works the same on every list.** Every list operation takes `limit` and `cursor`, and returns `items` and
  `nextCursor`. Each operation's reference page lists its filters and sort fields.
- **`limit` is the page size**, not a total: how many items each page holds, up to the operation's maximum (most allow
  100). Iterating the items still reads to the end of the list. To stop after a number of items, stop the loop.
- **A cursor belongs to its filters.** Use a cursor only with the same operation, filters, sort and `limit` as the
  request that gave it; anything else is refused with [`INVALID_CURSOR`](/errors/INVALID_CURSOR/). `nextPage()`
  always reuses the first page's input, so it cannot get this wrong.
- **Fix a time window once.** When a filter is worked out from the current time ("changed in the last seven days"),
  work it out once, for the first page, and send the same values for every later page. A window recalculated for
  each page would not match the cursor.
- **The order is stable.** Items come in an order that does not change between pages, so nothing is skipped or
  repeated while you page.
- **Read only what you need.** Each page is one request. Prefer a filter to reading every page and discarding items,
  stop iterating once you have what you need, and pick a `limit` that suits the screen or batch rather than the
  largest one. There is no total count: to show one, count what you read.
- **Unknown filters are refused.** A filter or sort field the operation does not declare is refused
  ([`UNKNOWN_FILTER`](/errors/UNKNOWN_FILTER/), [`UNKNOWN_SORT`](/errors/UNKNOWN_SORT/)) rather than ignored.
