---
pageType: cli
sinceVersion: 5000115000000
resources:
  - knowledge-base
  - document
integrations: []
operations:
  - CreateIngestionBatch
  - ListIngestionBatchItems
---

# Keep a folder in step

`caitlyn kb sync` keeps a folder on your machine, or in a CI job's checkout, in step with a folder of a knowledge base. It compares the files with the documents, shows the plan (new, changed, moved, unchanged, and with `--remove-missing`, what to remove), asks before it changes anything, uploads, and waits until everything can be searched.

<!-- example: examples/cli/keep-a-folder-in-step.sh#sync -->
```sh
caitlyn kb sync KB4T7YQ2WL "$handbook" --folder /handbook/ --remove-missing --yes
```

## In CI

In CI the command never asks. A plan it can't settle on its own (a file whose path another document already has, for example) is written to the report file, and the command exits 3, so the job stops for a person to decide:

<!-- example: examples/cli/keep-a-folder-in-step.sh#ci -->
```sh
# In CI it never asks: a plan with conflicts is written to plan.json, and the command exits 3
caitlyn kb sync KB4T7YQ2WL "$handbook" --folder /handbook/ --report json=plan.json --yes || echo "exit code $?"
```

To see what needs deciding, list the batch's unresolved items with `caitlyn kb ingestion batches items list --kb <kb> --batch <batch> --resolution unresolved`.

## Next

- [Look after a knowledge base](/cli/recipes/look-after-a-knowledge-base/): its documents and their status.
- [Exit codes](/cli/exit-codes/): 3 and the rest.
