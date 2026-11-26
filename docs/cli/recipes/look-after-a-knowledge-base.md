---
pageType: cli
sinceVersion: 5000115000000
resources:
  - knowledge-base
  - document
integrations: []
operations:
  - ListKnowledgeBases
  - ListDocuments
  - GetDocument
---

# Look after a knowledge base

List knowledge bases and their documents, check one document's status, and page through all of them in a script.

## List

On a terminal, each list is a table, with how many documents are still processing or failed:

<!-- example: examples/cli/look-after-a-knowledge-base.sh#list -->
```sh
caitlyn kb list
```

<!-- output: examples/cli/look-after-a-knowledge-base.sh -->
```text tab-output="Table"
NAME         ID          STATUS   PROCESSING  FAILED  UPDATED AT
────────────────────────────────────────────────────────────────
HR policies  KB4T7YQ2WL  ✓ ready  0           0       5 days ago

1 knowledge base
```
```json tab-output="JSON"
{
  "items": [
    {
      "id": "KB4T7YQ2WL",
      "name": "HR policies",
      "status": "ready",
      "documentCounts": {
        "processing": 0,
        "failed": 0,
        "outOfDate": 0
      },
      "createdAt": "2026-11-01T00:00:00.000Z",
      "updatedAt": "2026-11-01T00:00:00.000Z",
      "etag": "\"kb-KB4T7YQ2WL-1\""
    }
  ]
}
```

A list prints its first page and says how to get the rest:

<!-- example: examples/cli/look-after-a-knowledge-base.sh#documents -->
```sh
caitlyn kb documents list --kb KB4T7YQ2WL --limit 3
```

<!-- output: examples/cli/look-after-a-knowledge-base.sh -->
```text tab-output="Table"
NAME          ID        FOLDER      STATUS             VERSION  UPDATED AT
──────────────────────────────────────────────────────────────────────────
policy-1.pdf  doc-0001  /policies/  ✓ indexed          1        4 days ago
policy-2.pdf  doc-0002  /policies/  ✓ indexed          1        4 days ago
policy-3.pdf  doc-0003  /policies/  partially_indexed  1        4 days ago

3 documents
More: --all, or --cursor eyJvZmZzZXQiOjN9
```
```json tab-output="JSON"
{
  "items": [
    {
      "id": "doc-0001",
      "knowledgeBaseId": "KB4T7YQ2WL",
      "name": "policy-1.pdf",
      "folder": "/policies/",
      "status": "indexed",
      "contentType": "application/pdf",
      "byteSize": 1000,
      "sha256": "xj69y+AMBrfZMUMFa+K7N9ftx3xQdsHdOxyZMfNt24o=",
      "version": 1,
      "versionCount": 1,
      "createdAt": "2026-11-01T00:00:00.000Z",
      "updatedAt": "2026-11-02T00:00:00.000Z",
      "etag": "\"doc-0001-1\""
    },
    {
      "id": "doc-0002",
      "knowledgeBaseId": "KB4T7YQ2WL",
      "name": "policy-2.pdf",
      "folder": "/policies/",
      "status": "indexed",
      "contentType": "application/pdf",
      "byteSize": 2000,
      "sha256": "eJei0h2Xh+kI+Iy9qNchAQI9qYZoWeyIJ9gEZxiMFD4=",
      "version": 1,
      "versionCount": 1,
      "createdAt": "2026-11-01T00:00:00.000Z",
      "updatedAt": "2026-11-02T00:00:00.000Z",
      "etag": "\"doc-0002-1\""
    },
    {
      "id": "doc-0003",
      "knowledgeBaseId": "KB4T7YQ2WL",
      "name": "policy-3.pdf",
      "folder": "/policies/",
      "status": "partially_indexed",
      "contentType": "application/pdf",
      "byteSize": 3000,
      "sha256": "zFuki9CQp/jQr0lNR3ncAZ7Is7IwJMg2cYM7XmcRPzo=",
      "version": 1,
      "versionCount": 1,
      "createdAt": "2026-11-01T00:00:00.000Z",
      "updatedAt": "2026-11-02T00:00:00.000Z",
      "partialFailures": [
        {
          "code": "PICTURE_DESCRIPTION_FAILED",
          "detail": "page 4"
        }
      ],
      "etag": "\"doc-0003-1\""
    }
  ],
  "nextCursor": "eyJvZmZzZXQiOjN9"
}
```

## One document

A document's `status` says whether it can be searched: `indexed`, or `partially_indexed` when some of it couldn't be read, as `partial failures` counts:

<!-- example: examples/cli/look-after-a-knowledge-base.sh#get -->
```sh
caitlyn kb documents get doc-0003 --kb KB4T7YQ2WL
```

<!-- output: examples/cli/look-after-a-knowledge-base.sh -->
```text tab-output="Table"
policy-3.pdf  doc-0003

  knowledge base id   KB4T7YQ2WL
  folder              /policies/
  status              partially_indexed
  content type        application/pdf
  byte size           3000
  sha256              zFuki9CQp/jQr0lNR3ncAZ7Is7IwJMg2cYM7XmcRPzo=
  version             1
  version count       1
  created at          5 days ago
  updated at          4 days ago
  partial failures    1 item
  inherited from      /
  etag                "doc-0003-1"

  readers
  kind                inherit
```
```json tab-output="JSON"
{
  "id": "doc-0003",
  "knowledgeBaseId": "KB4T7YQ2WL",
  "name": "policy-3.pdf",
  "folder": "/policies/",
  "status": "partially_indexed",
  "contentType": "application/pdf",
  "byteSize": 3000,
  "sha256": "zFuki9CQp/jQr0lNR3ncAZ7Is7IwJMg2cYM7XmcRPzo=",
  "version": 1,
  "versionCount": 1,
  "createdAt": "2026-11-01T00:00:00.000Z",
  "updatedAt": "2026-11-02T00:00:00.000Z",
  "partialFailures": [
    {
      "code": "PICTURE_DESCRIPTION_FAILED",
      "detail": "page 4"
    }
  ],
  "readers": {
    "kind": "inherit"
  },
  "inheritedFrom": "/",
  "etag": "\"doc-0003-1\""
}
```
```yaml tab-output="YAML"
id: doc-0003
knowledgeBaseId: KB4T7YQ2WL
name: policy-3.pdf
folder: /policies/
status: partially_indexed
contentType: application/pdf
byteSize: 3000
sha256: zFuki9CQp/jQr0lNR3ncAZ7Is7IwJMg2cYM7XmcRPzo=
version: 1
versionCount: 1
createdAt: "2026-11-01T00:00:00.000Z"
updatedAt: "2026-11-02T00:00:00.000Z"
partialFailures:
  - code: PICTURE_DESCRIPTION_FAILED
    detail: page 4
readers:
  kind: inherit
inheritedFrom: /
etag: '"doc-0003-1"'
7
```

## In a script

`--all` follows every page, and `--output jsonl` prints one document per line as the pages arrive, so a long list never has to fit in memory:

<!-- example: examples/cli/look-after-a-knowledge-base.sh#count -->
```sh
# Every page, one document per line, counted
caitlyn kb documents list --kb KB4T7YQ2WL --all --output jsonl | wc -l | tr -d ' '
```

## Next

- [Keep a folder in step](/cli/recipes/keep-a-folder-in-step/): upload what changed, from your machine or from CI.
- [caitlyn knowledge-bases documents](/cli/reference/knowledge-bases/documents/): every command on documents.
