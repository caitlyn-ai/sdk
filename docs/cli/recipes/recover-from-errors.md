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

A command that fails ends with an exit code from one fixed table, and prints the error on stderr: JSON when stderr is not a terminal, with `exitCode` and a `hint` whose `next` commands are complete, reusing what the failed command was given. A script branches on the exit code; an AI agent runs the hint.

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

## Next

- [Exit codes](/cli/exit-codes/): every exit code.
- [Errors in the CLI](/cli/errors/): every error code and the CLI's hint for it.
