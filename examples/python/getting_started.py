# The developer docs' Getting started page (docs/getting-started.md) shows the `first-call` region.
# scripts/test-python.sh type-checks this file against the SDK (pyright --strict).
# #region first-call
import os

from caitlyn import Caitlyn
from caitlyn.auth import Token

caitlyn = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token(os.environ["CAITLYN_TOKEN"]))

# Read the draft of an agent: its configuration and its ETag
draft = caitlyn.versions.get(agent_id="GHT7YRWXPL", version="draft")
print(draft.configuration.instructions)
# #endregion
