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

# Read the draft of an agent: its configuration and its ETag
draft = caitlyn.agents.versions.get(agent_id="GHT7YRWXPL", version="draft")
print(draft.configuration.instructions)
```

Python 3.12 and later. The documentation, with getting started and every operation, is at
https://build.caitlyn.ai/. The source is at https://github.com/caitlyn-ai/sdk. Apache-2.0.
