#!/bin/sh
# Checks that a cosign public key (PEM, as `cosign public-key` writes it) is the one the CLI's binaries are built
# with: CAITLYN_COSIGN_PUBLIC_KEY, one line of base64 DER (the PEM's body). A release whose signatures the published
# key and the binaries disagree on would be unverifiable, so cli:release and cli:publish stop on a mismatch.
#
#   scripts/cosign-key-check.sh cosign.pub
set -eu
pem="${1:?usage: cosign-key-check.sh <cosign.pub>}"
: "${CAITLYN_COSIGN_PUBLIC_KEY:?CAITLYN_COSIGN_PUBLIC_KEY is the release key the binaries are built with}"
body="$(grep -v -- '-----' "$pem" | tr -d ' \n\r')"
if [ -z "$body" ] || [ "$body" != "$(printf '%s' "$CAITLYN_COSIGN_PUBLIC_KEY" | tr -d ' \n\r')" ]; then
  echo "cosign-key-check: $pem isn't CAITLYN_COSIGN_PUBLIC_KEY, the key the binaries carry" >&2
  exit 1
fi
echo "cosign-key-check: $pem is the key the binaries carry"
