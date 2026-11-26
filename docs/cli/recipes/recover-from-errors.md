---
pageType: cli
sinceVersion: 5000115000000
resources:
  - agent
integrations: []
operations:
  - SaveDraftVersion
  - UpdateDraftVersion
  - GetAgent
---

# Recover from errors

A command that fails ends with an exit code from one fixed table, and prints the error on stderr. For a script, a CI job or an AI agent it is JSON, with `exitCode` and a `hint` whose `next` commands are complete, reusing what the failed command was given. A script branches on the exit code; an AI agent runs the hint. A person at a terminal gets the same error as a message instead (see [What a person sees](#what-a-person-sees)).

## A name already used

<!-- example: examples/cli/recover-from-errors.sh#already-exists -->
```sh
# A version name the agent already has: exit code 7
caitlyn agents draft save GHT7YRWXPL --name v12
echo "exit code $?"
```

Exit code 7. Choose another name.

## A stale ETag

Someone changed the draft after you read it. Exit code 7, and the hint reads the draft again, then retries with the new ETag:

<!-- example: examples/cli/recover-from-errors.sh#stale -->
```sh
# A stale ETag: someone changed the draft after it was read. Exit code 7, and the hint reads it again
caitlyn agents draft update GHT7YRWXPL --if-match '"draft-stale"' --set guidance.instructions=Shorter.
echo "exit code $?"
```

## Something that doesn't exist

The same as something that isn't shared with you, so identifiers can't be probed. Exit code 6, and the hint lists what does exist:

<!-- example: examples/cli/recover-from-errors.sh#not-found -->
```sh
# An agent that doesn't exist, or isn't shared with you: exit code 6, and the hint lists the agents
caitlyn agents get NOPE0000
echo "exit code $?"
```

## A usage error

A flag left out, or one the command doesn't have. Exit code 2, and nothing was sent; the hint names the missing flag and gives an example:

<!-- example: examples/cli/recover-from-errors.sh#usage -->
```sh
# A required flag left out: exit code 2, and nothing was sent
caitlyn agents draft save GHT7YRWXPL
echo "exit code $?"
```

## What a person sees

At a terminal, outside CI and not under an AI agent, the error is a message, even when JSON is your configured output. `--error-format human` asks for it anywhere, and `--error-format json` asks for the JSON at a terminal; `CAITLYN_ERROR_FORMAT` does the same for every command. The exit code doesn't change:

<!-- example: examples/cli/recover-from-errors.sh#person -->
```sh
# What a person at a terminal sees for the same not-found error (--error-format human asks for it here)
caitlyn agents get NOPE0000 --error-format human
echo "exit code $?"
```

<!-- output: examples/cli/recover-from-errors.sh -->
```text
✗ Not found

  No agent NOPE0000

  → Find a valid identifier:
      caitlyn agents list

  404 NOT_FOUND · request <request-id>
  https://build.caitlyn.ai/errors/NOT_FOUND
  docs: https://build.caitlyn.ai/cli/reference/agents/#get
exit code 6
```

## Next

- [Exit codes](/cli/exit-codes/): every exit code.
- [Errors in the CLI](/cli/errors/): every error code and the CLI's hint for it.
