---
pageType: cli
sinceVersion: 5000115000000
resources:
  - agent
  - version
integrations: []
operations:
  - GetAgentVersion
  - UpdateDraftVersion
  - SaveDraftVersion
  - CompareAgentVersions
  - PublishAgentVersion
  - ListHistoryEntries
---

# Change an agent safely

Every agent has a draft, which is what you change, and a live version, which is what people talk to. A change goes from the draft to a saved version, then to live; rolling back is publishing an earlier version again. Nothing you do to the draft changes what people get until you publish.

## Change the draft

Read the draft's ETag first, and send it with the change: if someone else changed the draft since, the update is refused with exit code 7 rather than overwriting their work.

<!-- example: examples/cli/change-an-agent.sh#edit -->
```sh
# Read the draft's ETag, then change its instructions only if nobody has changed the draft since
etag=$(caitlyn agents draft get GHT7YRWXPL --jq .etag)
caitlyn agents draft update GHT7YRWXPL --if-match "$etag" \
  --set 'guidance.instructions=Answer from the HR policies, and quote the clause you relied on.' \
  --jq .configuration.guidance.instructions
```

## Save it, and see what changed

Saving keeps the draft as it is now as a new named version; versions never change once made:

<!-- example: examples/cli/change-an-agent.sh#save -->
```sh
caitlyn agents draft save GHT7YRWXPL --name november-candidate --note "Quotes the policy clause it relied on."
```

<!-- output: examples/cli/change-an-agent.sh -->
```text tab-output="Table"
✓ Done: save the draft as a version (november-candidate).
```
```json tab-output="JSON"
{
  "agentId": "GHT7YRWXPL",
  "name": "november-candidate",
  "source": "save",
  "matchesLive": false,
  "createdAt": "2026-11-06T08:58:00.000Z",
  "createdBy": {
    "displayName": "Mock caller"
  },
  "note": "Quotes the policy clause it relied on.",
  "configuration": {
    "guidance": {
      "identity": "You are the HR assistant.",
      "instructions": "Answer from the HR policies, and quote the clause you relied on."
    },
    "models": {
      "answer": {
        "model": "claude-sonnet-5-5"
      }
    },
    "knowledgeBases": [
      {
        "knowledgeBaseId": "KB4T7YQ2WL",
        "numberOfResults": 6,
        "minimumScore": 0.3
      }
    ],
    "attachments": {
      "enabled": true,
      "maxFiles": 5
    },
    "contentSafety": {
      "guardrail": "default"
    },
    "deniedDocuments": false
  },
  "etag": "\"version-GHT7YRWXPL-november-candidate-1\""
}
```

Compare it with what is live before publishing:

<!-- example: examples/cli/change-an-agent.sh#compare -->
```sh
caitlyn agents versions compare GHT7YRWXPL@v13 --with-version november-candidate
```

<!-- output: examples/cli/change-an-agent.sh -->
```text tab-output="Table"
~ guidance.instructions
    - Answer from the HR policies.
    + Answer from the HR policies, and quote the clause you relied on.

1 change
```
```json tab-output="JSON"
{
  "changes": [
    {
      "path": "guidance",
      "before": {
        "identity": "You are the HR assistant.",
        "instructions": "Answer from the HR policies."
      },
      "after": {
        "identity": "You are the HR assistant.",
        "instructions": "Answer from the HR policies, and quote the clause you relied on."
      }
    }
  ]
}
```

## Publish

Publishing is `user-facing`: everyone talking to the agent gets the new version. `--expected-live` names the version you expect to replace, so a publish made while someone else published in between is refused. In CI, and under an AI agent, it needs `--yes`, and `--confirm <agent>` too.

<!-- example: examples/cli/change-an-agent.sh#publish -->
```sh
# Publishing changes what everyone talking to the agent gets
caitlyn agents versions publish GHT7YRWXPL@november-candidate --expected-live v13 --note "Reviewed by HR" --yes
```

<!-- output: examples/cli/change-an-agent.sh -->
```text tab-output="Table"
✓ Done: publish a version.
```
```json tab-output="JSON"
{
  "live": {
    "version": "november-candidate",
    "publishedAt": "2026-11-06T08:58:00.000Z",
    "publishedBy": {
      "displayName": "Mock caller"
    }
  },
  "version": {
    "agentId": "GHT7YRWXPL",
    "name": "november-candidate",
    "source": "save",
    "matchesLive": true,
    "createdAt": "2026-11-06T08:58:00.000Z",
    "createdBy": {
      "displayName": "Mock caller"
    },
    "note": "Quotes the policy clause it relied on.",
    "configuration": {
      "guidance": {
        "identity": "You are the HR assistant.",
        "instructions": "Answer from the HR policies, and quote the clause you relied on."
      },
      "models": {
        "answer": {
          "model": "claude-sonnet-5-5"
        }
      },
      "knowledgeBases": [
        {
          "knowledgeBaseId": "KB4T7YQ2WL",
          "numberOfResults": 6,
          "minimumScore": 0.3
        }
      ],
      "attachments": {
        "enabled": true,
        "maxFiles": 5
      },
      "contentSafety": {
        "guardrail": "default"
      },
      "deniedDocuments": false
    },
    "etag": "\"version-GHT7YRWXPL-november-candidate-1\""
  },
  "historyEntry": {
    "id": "lh-0002",
    "agentId": "GHT7YRWXPL",
    "version": "november-candidate",
    "previousVersion": "v13",
    "kind": "publish",
    "changedAt": "2026-11-06T08:58:00.000Z",
    "changedBy": {
      "displayName": "Mock caller"
    },
    "note": "Reviewed by HR"
  }
}
```

## Roll back

Publish the earlier version again:

<!-- example: examples/cli/change-an-agent.sh#roll-back -->
```sh
# Roll back: publish the earlier version again
caitlyn agents versions publish GHT7YRWXPL@v13 --expected-live november-candidate --note "Back to v13" --yes
```

<!-- output: examples/cli/change-an-agent.sh -->
```text tab-output="Table"
✓ Done: publish a version.
```
```json tab-output="JSON"
{
  "live": {
    "version": "v13",
    "publishedAt": "2026-11-06T08:58:00.000Z",
    "publishedBy": {
      "displayName": "Mock caller"
    }
  },
  "version": {
    "agentId": "GHT7YRWXPL",
    "name": "v13",
    "source": "publish",
    "matchesLive": true,
    "createdAt": "2026-11-05T00:00:00.000Z",
    "createdBy": {
      "displayName": "Mock caller"
    },
    "configuration": {
      "guidance": {
        "identity": "You are the HR assistant.",
        "instructions": "Answer from the HR policies."
      },
      "models": {
        "answer": {
          "model": "claude-sonnet-5-5"
        }
      },
      "knowledgeBases": [
        {
          "knowledgeBaseId": "KB4T7YQ2WL",
          "numberOfResults": 6,
          "minimumScore": 0.3
        }
      ],
      "attachments": {
        "enabled": true,
        "maxFiles": 5
      },
      "contentSafety": {
        "guardrail": "default"
      },
      "deniedDocuments": false
    },
    "etag": "\"version-GHT7YRWXPL-v13-1\""
  },
  "historyEntry": {
    "id": "lh-0003",
    "agentId": "GHT7YRWXPL",
    "version": "v13",
    "previousVersion": "november-candidate",
    "kind": "rollback",
    "changedAt": "2026-11-06T08:58:00.000Z",
    "changedBy": {
      "displayName": "Mock caller"
    },
    "note": "Back to v13"
  }
}
```

The history records it as a rollback:

<!-- example: examples/cli/change-an-agent.sh#history -->
```sh
caitlyn agents history list --agent GHT7YRWXPL
```

<!-- output: examples/cli/change-an-agent.sh -->
```text tab-output="Table"
CHANGED AT     KIND      VERSION             PREVIOUS VERSION    CHANGED BY
────────────────────────────────────────────────────────────────────────────
2 minutes ago  rollback  v13                 november-candidate  Mock caller
2 minutes ago  publish   november-candidate  v13                 Mock caller
1 day ago      publish   v13                 v12                 Mock caller

3 history entries
```
```json tab-output="JSON"
{
  "items": [
    {
      "id": "lh-0003",
      "agentId": "GHT7YRWXPL",
      "version": "v13",
      "previousVersion": "november-candidate",
      "kind": "rollback",
      "changedAt": "2026-11-06T08:58:00.000Z",
      "changedBy": {
        "displayName": "Mock caller"
      },
      "note": "Back to v13"
    },
    {
      "id": "lh-0002",
      "agentId": "GHT7YRWXPL",
      "version": "november-candidate",
      "previousVersion": "v13",
      "kind": "publish",
      "changedAt": "2026-11-06T08:58:00.000Z",
      "changedBy": {
        "displayName": "Mock caller"
      },
      "note": "Reviewed by HR"
    },
    {
      "id": "lh-0002",
      "agentId": "GHT7YRWXPL",
      "version": "v13",
      "previousVersion": "v12",
      "kind": "publish",
      "changedAt": "2026-11-05T00:00:00.000Z",
      "changedBy": {
        "displayName": "Mock caller"
      }
    }
  ]
}
```

## Next

- [Recover from errors](/cli/recipes/recover-from-errors/): a stale ETag, a name already used, and the rest.
- [caitlyn agents draft](/cli/reference/agents/draft/): every command on the draft.
