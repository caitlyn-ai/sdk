# Caitlyn CLI

> **Preview.** The Caitlyn CLI is in preview: its commands, flags and output may still change. Its stability is
> `cmdutil.Stability` (`cli/internal/cmdutil/stability.go`), which `caitlyn version`, the root help and the installers
> read.

The Go command-line tool on the Go SDK: profiles, browser and device-code sign-in, commands generated from the
model, `caitlyn api` for any operation by name, JSON output and streaming chat, to be released through a Homebrew
tap under `github.com/caitlyn-ai`.

The integrations MCP server will live beside it, in `mcp/`.

## Design notes

**Named profiles** (decided 11 November 2026), as `~/.aws/config` works: `~/.caitlyn/config` holds named
profiles, each a workspace and its settings (sign-in mode and its options, an endpoint override, output format),
chosen with `--profile` or `CAITLYN_PROFILE`, with a `default` profile. The workspace plays the part an AWS
region plays: as in the SDKs, it decides both the endpoint (`https://<workspace>/api`) and the audience of every
token (`https://<workspace>/api`), and an endpoint override changes only where requests go. Secrets and tokens
go to the operating system's credential store, never into the config file.

## Verifying a release

Releases are signed twice. `manifest.json`, which the installers and `caitlyn update` read, is signed with minisign
(`https://build.caitlyn.ai/releases/cli/keys/minisign.pub`). `checksums.txt`, which names every archive and package by
SHA-256, and the container image `ghcr.io/caitlyn-ai/caitlyn` are signed with cosign, with a key held in AWS KMS
that only the release jobs can sign with. Its public half is at `https://build.caitlyn.ai/releases/cli/cosign.pub`, and every
binary carries both keys (`caitlyn version --json` shows them under `signingKeys`). The image is built from the
release's own linux archives, so it holds exactly the binaries the release published.

```sh
# the image (any of its tags: X.Y.Z, X.Y, latest)
cosign verify --key https://build.caitlyn.ai/releases/cli/cosign.pub ghcr.io/caitlyn-ai/caitlyn:0.13.0

# an archive: the checksums file's signature, then the archive's checksum
base=https://build.caitlyn.ai/releases/cli/0.13.0
curl -fsSLO "$base/checksums.txt" -fsSLO "$base/checksums.txt.sigstore.json" -fsSLO "$base/caitlyn_0.13.0_linux_amd64.tar.gz"
cosign verify-blob --key https://build.caitlyn.ai/releases/cli/cosign.pub --bundle checksums.txt.sigstore.json checksums.txt
sha256sum --check --ignore-missing checksums.txt
```
