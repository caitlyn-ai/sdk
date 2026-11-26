---
pageType: cli
sinceVersion: 0
resources: []
integrations: []
operations: []
---

# Installing the CLI

`caitlyn` is one binary for macOS, Linux and Windows, on amd64 and arm64. Every channel below installs the same release.

## The install script

```sh
curl -fsSL https://build.caitlyn.ai/releases/cli/install.sh | sh          # macOS and Linux
irm https://build.caitlyn.ai/releases/cli/install.ps1 | iex                # Windows (PowerShell)
```

The script reads the release's manifest, downloads the archive for your machine, checks its size and SHA-256 against the manifest, and installs the binary: to `~/.local/bin` on macOS and Linux, and to `%LOCALAPPDATA%\Programs\caitlyn` on Windows, which it adds to your `PATH`. These variables change what it does:

| Variable | Default | |
| --- | --- | --- |
| `CAITLYN_INSTALL_VERSION` | the channel's newest | A version to install, such as `0.12.0` |
| `CAITLYN_CHANNEL` | `stable` | `stable` or `beta` |
| `CAITLYN_INSTALL_DIR` | as above | Where the binary goes |
| `CAITLYN_REQUIRE_SIGNATURE` | unset | `1`: stop when the signature can't be checked |

```sh
curl -fsSL https://build.caitlyn.ai/releases/cli/install.sh | CAITLYN_INSTALL_VERSION=0.12.0 sh
```

The manifest is signed with minisign, and the script checks that signature before it trusts the checksums, refusing a release whose signature doesn't verify. It needs nothing extra to do so: on macOS and Linux it uses [minisign](https://jedisct1.github.io/minisign/) when you have it, else OpenSSL 3 or Node.js, and on Windows it checks the signature itself. On the rare machine with none of them, it warns that it couldn't check the signature and relies on the checksum and the HTTPS download; set `CAITLYN_REQUIRE_SIGNATURE=1` to stop instead, as the GitHub action does.

## Package managers

```sh
brew install caitlyn-ai/tap/caitlyn

scoop bucket add caitlyn https://github.com/caitlyn-ai/scoop-bucket
scoop install caitlyn
```

Homebrew also installs shell completions for bash, zsh and fish.

## The container image

`ghcr.io/caitlyn-ai/caitlyn` has the CLI and a shell, for CI jobs:

```yaml
image: ghcr.io/caitlyn-ai/caitlyn:0.12
script:
  - caitlyn apply -f caitlyn/ --yes
```

Its tags are each version (`0.12.4`), each minor line (`0.12`) and `latest`. Pin a version or a minor line in CI. The image holds the same binaries as the release's archives.

## Archives and packages

Every release is at `https://build.caitlyn.ai/releases/cli/<version>/`:

- `caitlyn_<version>_<os>_<arch>.tar.gz` (`.zip` on Windows), with the binary, shell completions and licence;
- `.deb` and `.rpm` packages for Linux;
- `checksums.txt`, and `manifest.json` with its minisign signature `manifest.json.minisig`;
- `checksums.txt.sigstore.json`, the checksums file's cosign signature, and an SBOM for each archive and package.

## Verifying a release

Check the manifest's signature with the release key, then the archive's SHA-256 against the manifest:

```sh
v=0.12.4
base=https://build.caitlyn.ai/releases/cli
curl -fsSLO "$base/$v/manifest.json" -fsSLO "$base/$v/manifest.json.minisig"
curl -fsSLO "$base/$v/caitlyn_${v}_linux_amd64.tar.gz"
curl -fsSL "$base/keys/minisign.pub" -o caitlyn-minisign.pub
minisign -Vm manifest.json -p caitlyn-minisign.pub
grep "caitlyn_${v}_linux_amd64.tar.gz" manifest.json   # compare its sha256 with:
sha256sum "caitlyn_${v}_linux_amd64.tar.gz"
```

A key fetched from the same place as the release only proves the two match. Compare it with the key built into a `caitlyn` you already trust, which every release carries; the two lines must be the same:

```sh
tail -n 1 caitlyn-minisign.pub
caitlyn version --json --jq .signingKeys.minisign
```

The checksums file and the container image are also signed with [cosign](https://docs.sigstore.dev/cosign/), with the release key published at `https://build.caitlyn.ai/releases/cli/cosign.pub`. Every binary carries the same key: `caitlyn version --json` shows it under `signingKeys`.

```sh
curl -fsSLO "$base/$v/checksums.txt" -fsSLO "$base/$v/checksums.txt.sigstore.json"
cosign verify-blob --key https://build.caitlyn.ai/releases/cli/cosign.pub --bundle checksums.txt.sigstore.json checksums.txt
sha256sum --check --ignore-missing checksums.txt

cosign verify --key https://build.caitlyn.ai/releases/cli/cosign.pub ghcr.io/caitlyn-ai/caitlyn:0.12.4
```

Compare the cosign key with the one built into a `caitlyn` you trust in the same way: the key file's body, without its `BEGIN` and `END` lines, is the `signingKeys.cosign` value.

```sh
curl -fsSL https://build.caitlyn.ai/releases/cli/cosign.pub | grep -v -- ----- | tr -d '\n'; echo
caitlyn version --json --jq .signingKeys.cosign
```

## Updates

```sh
caitlyn update --check      # is there a newer release?
caitlyn update              # install it
caitlyn update --channel beta
caitlyn update --rollback   # back to the version you had before
```

`caitlyn update` updates an install made with the script or an archive. It installs a release only after checking the manifest's signature with the key built into the CLI, and the download's checksum, and it keeps the version it replaces so `--rollback` can restore it. An install from Homebrew, Scoop, a deb or rpm package, or the container image is updated by that package manager, and `caitlyn update` tells you the command: `brew upgrade caitlyn`, `scoop update caitlyn`, or a newer image tag.

## Next

Sign in to your workspace, then try [a first session](/cli/#a-first-session):

```sh
caitlyn auth login --workspace your-company.caitlyn.ai
```
