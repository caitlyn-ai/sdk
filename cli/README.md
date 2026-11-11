# Caitlyn CLI

The Go command-line tool on the Go SDK (lane C1 of the v3 implementation plan): profiles, browser and
device-code sign-in, commands generated from the model, `caitlyn api` for any operation by name, JSON output
and streaming chat. Released through the Homebrew tap under `github.com/caitlyn-ai` (lane R2).

Not started. The integrations MCP server (lane P1) will live beside it, in `mcp/`.

## Design notes

**Named profiles** (Sam, 11 November 2026), as `~/.aws/config` works: `~/.caitlyn/config` holds named
profiles, each a workspace and its settings (sign-in mode and its options, an endpoint override, output format),
chosen with `--profile` or `CAITLYN_PROFILE`, with a `default` profile. The workspace plays the part an AWS
region plays: as in the SDKs, it decides both the endpoint (`https://<workspace>/api`) and the audience of every
token (`https://<workspace>/api/v3`), and an endpoint override changes only where requests go. Secrets and tokens
go to the operating system's credential store, never into the config file.
