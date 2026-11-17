# caitlyn

The Python SDK for the Caitlyn API (v3): typed clients, synchronous (`Caitlyn`) and asynchronous
(`AsyncCaitlyn`), with sign-in, retries, streamed answers and OpenTelemetry tracing.

```sh
pip install caitlyn
```

```python
import os

from caitlyn import Caitlyn
from caitlyn.auth import Token

caitlyn = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token(os.environ["CAITLYN_TOKEN"]))

# Add a file to a knowledge base: the SDK hashes and uploads it, creates the document, then waits until it is searchable
kb = caitlyn.knowledge_bases("KB4T7YQ2WL")
doc = kb.documents.create("leave-policy.pdf", folder="/hr/").wait()
print(doc.id, doc.status)
```

Python 3.12 and later. The documentation, with getting started and every operation, is at
https://build.caitlyn.ai/. The source is at https://github.com/caitlyn-ai/sdk. Apache-2.0.
