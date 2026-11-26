---
pageType: cli
sinceVersion: 0
resources: []
integrations: []
operations: []
---

# Your own traces and usage data for Caitlyn

The CLI has two kinds of telemetry. They are separate: each has its own switch, and neither ever turns the other on.

| | Your own traces | Usage data for Caitlyn |
| --- | --- | --- |
| What it is | OpenTelemetry traces of your commands and their API calls, for you | Anonymous usage data about the CLI, for Caitlyn |
| Who receives it | Your own OpenTelemetry collector | Caitlyn |
| What it sends | A span per command and per API call: operations, timings, status codes and request IDs | One event per command run: the fields [below](#what-is-sent), and nothing else |
| On by default | No: only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set | No: only when you turn it on |
| In CI | The same: on when the endpoint is set | Off, unless `CAITLYN_TELEMETRY=1` |
| Turn it on | Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `traces.otlp_endpoint` in your user file) | `caitlyn telemetry on`, or `CAITLYN_TELEMETRY=1` |
| Turn it off | Unset the endpoint, or set `OTEL_SDK_DISABLED=true` | `caitlyn telemetry off`, `CAITLYN_TELEMETRY=0`, or `DO_NOT_TRACK=1` |

Every request also carries a user agent, which tells your workspace which client called it: the CLI, SDK and Go versions, the operating system, and the CI system and AI agent when the CLI detects one. That is neither kind of telemetry, and it goes only to your workspace.

## Your own traces

Point the CLI at an OpenTelemetry collector you run, and every command sends it a trace over OTLP/HTTP: a root span named after the command (`caitlyn kb sync`), and a span for each API call under it. Each API request carries W3C `traceparent`, so the trace continues into Caitlyn.

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com:4318
caitlyn kb sync KB4T7YQ2WL ./policies
```

The standard OpenTelemetry variables apply:

| Variable | What it does |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The collector's base URL; spans go to `/v1/traces` under it. Or set `traces.otlp_endpoint` in your user file |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | The full URL for traces, used as it is |
| `OTEL_EXPORTER_OTLP_HEADERS` | Headers for the collector, such as an API key: `key=value` pairs separated by commas |
| `OTEL_SERVICE_NAME` | `service.name` on every span; `caitlyn-cli` when unset |
| `OTEL_RESOURCE_ATTRIBUTES` | More resource attributes: `key=value` pairs separated by commas |
| `OTEL_SDK_DISABLED` | `true` sends nothing, whatever else is set |

Spans hold operations, timings, status codes and request IDs. They never hold a token, the `Authorization` header, a request or response body, or the value of an argument. The CLI sends the trace as the command ends, and waits at most a second for your collector, so a collector that is down never holds a command up for longer.

Your own traces go only to the collector you name. Caitlyn never receives them, and `caitlyn telemetry` doesn't change them.

## Usage data for Caitlyn

The CLI can send Caitlyn anonymous usage data, so we can see which commands are used and which fail, and make the CLI better. It never sends what you typed, what Caitlyn returned, or anything that identifies you or your workspace. It is opt-in, in every release, stable and beta alike, and off in CI: nothing is sent unless you turn it on.

```sh
caitlyn telemetry on
```

`caitlyn telemetry` and its subcommands are only about usage data for Caitlyn. The rest of this page is too.

## What is sent

Usage data for Caitlyn is one event per command run, with these fields:

| Field | For example |
| --- | --- |
| The command | `kb sync`, `agents draft save` |
| The names of the flags used, never their values | `["--remove-missing", "--yes", "--output"]` |
| The exit code | `3` |
| How long it took, to the nearest 10 ms | `52.31 s` |
| The CLI's version and release channel | `0.12.0`, `stable` |
| The operating system and architecture | `darwin`, `arm64` |
| Whether it ran in CI, and which CI | `ci: true`, `gitlab` |
| Whether an AI agent ran it, and which | `agent: claude-code` |
| Whether stdin, stdout and stderr were terminals | `[true, false, true]` |
| An anonymous install ID | A random UUID made on the first run, unrelated to the machine, you or your workspace. `caitlyn telemetry reset` makes a new one |
| An event ID, and the hour it ran in | For removing duplicates |

A flag's name is taken from the CLI's own list of flags, so a value can't be sent by being mistaken for one: a flag the CLI doesn't know is sent as `unknown`.

An example event, exactly as it is queued and sent. Every event has these fields and no others; the payload sent is `{"events": [...]}`:

```json
{
  "event_id": "3b0f9a52-8c1e-4f7a-9d6b-2e5c7a1f0b84",
  "time": "2026-11-25T09:00:00Z",
  "install_id": "f1c2d3e4-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "command": "agents draft save",
  "flags": ["--if-match", "--name", "--note"],
  "exit_code": 0,
  "duration_ms": 840,
  "version": "0.12.0",
  "channel": "stable",
  "os": "darwin",
  "arch": "arm64",
  "ci": false,
  "agent": false,
  "tty": [true, true, true]
}
```

`ci_provider` (such as `gitlab`) is added only when `ci` is true, and `agent_name` (such as `claude-code`) only when `agent` is true.

## What is never sent

- The values of arguments and flags, including `--output` and `--profile`.
- Identifiers of any kind: agents, knowledge bases, documents, conversations, request IDs.
- Content, file names and paths.
- Workspace names, hostnames and addresses.
- Error messages, which can quote your data; the exit code says enough.
- Names, email addresses and tokens.
- IP addresses: the endpoint does not store them.

`caitlyn telemetry status --pending` prints exactly what is waiting to be sent, so you can check it yourself.

## Turning usage data for Caitlyn on and off

The first rule that matches decides:

1. `CAITLYN_TELEMETRY=0` (or `off`) turns it off, and `CAITLYN_TELEMETRY=1` turns it on.
2. `DO_NOT_TRACK` set to anything but `0` turns it off.
3. `caitlyn telemetry off` (which writes `telemetry = false` in your own configuration file) turns it off.
4. In CI it is off, whatever your configuration file says.
5. `caitlyn telemetry on` (which writes `telemetry = true` in your own configuration file) turns it on.
6. Otherwise it is off, in every release, beta included.

A project's `.caitlyn.toml` can't turn it on or off: whether to share usage data is your choice, not a repository's. `caitlyn telemetry status` prints the decision and the rule that made it. Turning it off deletes anything waiting to be sent. None of these switches affects your own traces.

## The first-run notice

The first time you run the CLI at a terminal, it asks, once, on stderr:

```text
Usage data for Caitlyn. Help improve the Caitlyn CLI by sending Caitlyn anonymous usage
data: which commands and flags run, how long they take and whether they succeed. Never
arguments, IDs, content or anything about you or your workspace. It's off unless you
turn it on: caitlyn telemetry on
More: https://build.caitlyn.ai/cli/telemetry
```

Nothing is collected because of the notice: it only says how to turn usage data on. A run with no terminal, in CI or under an AI agent never shows it.

## Usage data for Caitlyn in CI

Off, as everywhere: an outbound call nobody expected is a finding in a security review. Set `CAITLYN_TELEMETRY=1` in a pipeline whose owners choose to share it.

## How usage data for Caitlyn is sent

- Each run adds its event to a small file in your home folder (`~/.caitlyn/telemetry/queue.jsonl`, readable only by you) as it exits. No network.
- When 20 events are waiting, or the oldest is a day old, the CLI starts a separate process that sends them over HTTPS, and exits without waiting for it. Sending gives up after 3 seconds and tries again next time; a command never waits on it.
- Events older than 7 days are dropped, and no more than 256 KB is ever kept.

## Where usage data for Caitlyn goes

To Caitlyn, never your workspace: the CLI may not be signed in, and usage data must never mix with your workspace's data. It is stored in Singapore (the ap-southeast-1 Region) for 13 months (395 days), then deleted.
