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

A list operation returns its results a page at a time. The SDKs hide the pages: iterate the result and each page
is fetched when the loop reaches it, so a `break` stops fetching.

> **Not yet available.** No Caitlyn release serves [ListDocuments](/reference/list-documents/) yet. This page
> describes how the SDKs handle lists.

<!-- example: examples/typescript/concepts.ts#pagination -->
```ts tab="TypeScript"
// Every document in the folder: the next page is fetched as the loop reaches it
for await (const document of caitlyn.documents.list({ knowledgeBaseId: 'KB4T7YQ2WL', folder: 'hr/', limit: 100 })) {
  console.log(document.name, document.status);
}
```
<!-- example: examples/python/concepts.py#pagination -->
```python tab="Python"
# Every document in the folder: the next page is fetched as the loop reaches it
for document in caitlyn.documents.list(knowledge_base_id="KB4T7YQ2WL", folder="hr/", limit=100):
    print(document.name, document.status)

# Or page by page
for page in caitlyn.documents.list(knowledge_base_id="KB4T7YQ2WL", limit=100).pages():
    print(len(page.items), page.next_cursor)
```
<!-- example: examples/go/concepts/concepts.go#pagination -->
```go tab="Go"
// Every document in the folder: the next page is fetched as the loop reaches it
input := &caitlyn.ListDocumentsInput{KnowledgeBaseID: "KB4T7YQ2WL", Folder: caitlyn.Ptr("hr/"), Limit: caitlyn.Ptr[int32](100)}
for document, err := range client.Documents.List(ctx, input) {
	if err != nil {
		return err
	}
	fmt.Println(document.Name, document.Status)
}

// Or page by page
for page, err := range client.Documents.ListPages(ctx, input) {
	if err != nil {
		return err
	}
	fmt.Println(len(page.Items), page.NextCursor)
}
```
<!-- example: examples/rust/src/concepts.rs#pagination -->
```rust tab="Rust"
// Every document in the folder: the next page is fetched as the loop reaches it
let input = ListDocumentsInput {
    knowledge_base_id: "KB4T7YQ2WL".into(),
    folder: Some("hr/".into()),
    limit: Some(100),
    ..Default::default()
};
let mut documents = client.documents().list(input.clone());
while let Some(document) = documents.next().await {
    let document = document?;
    println!("{} {:?}", document.name, document.status);
}

// Or page by page
let mut pages = client.documents().list_pages(input);
while let Some(page) = pages.next().await {
    let page = page?;
    println!("{} {:?}", page.items.len(), page.next_cursor);
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
