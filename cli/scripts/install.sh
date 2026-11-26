#!/bin/sh
# Installs the Caitlyn CLI on macOS or Linux (the CLI design, 8.4).
#
#   curl -fsSL https://build.caitlyn.ai/releases/cli/install.sh | sh
#
# It reads the channel's pointer and the release manifest from build.caitlyn.ai/releases/cli, checks the manifest's minisign
# signature with Caitlyn's release key, downloads the archive for this machine, checks its size and SHA-256 against
# the manifest, installs the binary, and writes ~/.caitlyn/install.json so `caitlyn update` knows it may update
# itself. The signature is checked with minisign when it is installed, else with OpenSSL 3 or Node.js, which most
# machines have; with none of them it says so and relies on HTTPS and the checksum, unless
# CAITLYN_REQUIRE_SIGNATURE=1, which stops instead.
#
# Settings, all optional:
#   CAITLYN_INSTALL_VERSION    a version to install, such as 0.12.0 (default: the channel's newest)
#   CAITLYN_CHANNEL            stable or beta (default: stable)
#   CAITLYN_INSTALL_DIR        where the binary goes (default: ~/.local/bin)
#   CAITLYN_CONFIG_DIR         the user folder, for install.json (default: ~/.caitlyn)
#   CAITLYN_BASE_URL           where releases are (default: https://build.caitlyn.ai/releases/cli/)
#   CAITLYN_REQUIRE_SIGNATURE  1: stop when the signature can't be checked, rather than rely on the checksum
set -eu

base="${CAITLYN_BASE_URL:-https://build.caitlyn.ai/releases/cli/}"
case "$base" in */) ;; *) base="$base/" ;; esac
channel="${CAITLYN_CHANNEL:-stable}"
dir="${CAITLYN_INSTALL_DIR:-$HOME/.local/bin}"
config="${CAITLYN_CONFIG_DIR:-$HOME/.caitlyn}"
# The manifest signing key's public half, filled in when the release job publishes this script.
pubkey="__MINISIGN_PUBLIC_KEY__"

say() { printf '%s\n' "$*" >&2; }
fail() { say "caitlyn install: $*"; exit 1; }

# verify_minisign PUBKEY FILE SIG checks a minisign signature exactly as `minisign -V` does, with whichever of
# minisign, OpenSSL 3 or Node.js is here: the key IDs match; the signature is Ed25519 over the file, or over its
# BLAKE2b-512 hash for the "ED" algorithm minisign signs with by default; and the global signature covers the
# signature and its trusted comment. Exit status 0 verified, 1 refused, 2 nothing here can check it.
verify_minisign() {
  if command -v minisign > /dev/null 2>&1; then
    minisign -Vqm "$2" -x "$3" -P "$1" > /dev/null 2>&1 && return 0 || return 1
  fi
  if command -v openssl > /dev/null 2>&1 && openssl pkeyutl -help 2>&1 | grep -q -- '-rawin' \
    && printf '' | openssl dgst -blake2b512 > /dev/null 2>&1; then
    verify_openssl "$@"
    return
  fi
  if command -v node > /dev/null 2>&1; then
    # 3 is a signature that doesn't match; anything else but 0 (a Node too old for Ed25519 or BLAKE2b, or one that
    # can't run the script) is "can't check", never a forged release
    s=0
    node -e "$NODE_VERIFY" "$1" "$2" "$3" 2> /dev/null || s=$?
    case "$s" in 0) return 0 ;; 3) return 1 ;; *) return 2 ;; esac
  fi
  return 2
}

verify_openssl() (
  v="$(mktemp -d)"
  trap 'rm -rf "$v"' EXIT
  b64d() { openssl base64 -d -A; }
  printf '%s' "$1" | b64d > "$v/pk" 2> /dev/null || exit 1
  sed -n 2p "$3" | tr -d '\r' | b64d > "$v/sig" 2> /dev/null || exit 1
  sed -n 4p "$3" | tr -d '\r' | b64d > "$v/global" 2> /dev/null || exit 1
  comment="$(sed -n 3p "$3" | tr -d '\r')"
  case "$comment" in "trusted comment: "*) ;; *) exit 1 ;; esac
  [ "$(wc -c < "$v/pk" | tr -d ' ')" = 42 ] && [ "$(wc -c < "$v/sig" | tr -d ' ')" = 74 ] || exit 1
  [ "$(head -c 2 "$v/pk")" = Ed ] || exit 1
  head -c 10 "$v/pk" | tail -c 8 > "$v/pk.id"
  head -c 10 "$v/sig" | tail -c 8 > "$v/sig.id"
  cmp -s "$v/pk.id" "$v/sig.id" || exit 1
  # An Ed25519 public key as PEM: the 12-byte SubjectPublicKeyInfo header (MCowBQYDK2VwAyEA in base64) and the key
  printf -- '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA%s\n-----END PUBLIC KEY-----\n' "$(tail -c 32 "$v/pk" | openssl base64 -A)" > "$v/pk.pem"
  tail -c 64 "$v/sig" > "$v/sig.ed"
  case "$(head -c 2 "$v/sig")" in
    ED) openssl dgst -blake2b512 -binary "$2" > "$v/msg" ;;
    Ed) cp "$2" "$v/msg" ;;
    *) exit 1 ;;
  esac
  openssl pkeyutl -verify -pubin -inkey "$v/pk.pem" -rawin -in "$v/msg" -sigfile "$v/sig.ed" > /dev/null 2>&1 || exit 1
  { cat "$v/sig.ed"; printf '%s' "${comment#trusted comment: }"; } > "$v/global.msg"
  openssl pkeyutl -verify -pubin -inkey "$v/pk.pem" -rawin -in "$v/global.msg" -sigfile "$v/global" > /dev/null 2>&1 || exit 1
)

# Exits 0 verified, 3 not (a forgery or a damaged file), 2 when this Node can't check (before Node 12: no Ed25519)
NODE_VERIFY='
const fs = require("fs"), c = require("crypto");
if (typeof c.createPublicKey !== "function" || typeof c.verify !== "function" || c.getHashes().indexOf("blake2b512") < 0) process.exit(2);
const [pkB64, file, sigFile] = process.argv.slice(1);
const pk = Buffer.from(pkB64, "base64");
const lines = fs.readFileSync(sigFile, "utf8").split(/\r?\n/);
const sig = Buffer.from(lines[1] || "", "base64"), global = Buffer.from(lines[3] || "", "base64");
const fail = () => process.exit(3);
if (pk.length !== 42 || sig.length !== 74 || global.length !== 64 || pk.subarray(0, 2).toString() !== "Ed") fail();
if (!pk.subarray(2, 10).equals(sig.subarray(2, 10)) || !(lines[2] || "").startsWith("trusted comment: ")) fail();
let key;
try { key = c.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk.subarray(10)]), format: "der", type: "spki" }); } catch (e) { process.exit(2); }
const alg = sig.subarray(0, 2).toString();
let msg = fs.readFileSync(file);
if (alg === "ED") msg = c.createHash("blake2b512").update(msg).digest(); else if (alg !== "Ed") fail();
let ok;
try {
  ok = c.verify(null, msg, key, sig.subarray(10)) &&
    c.verify(null, Buffer.concat([sig.subarray(10), Buffer.from(lines[2].slice("trusted comment: ".length))]), key, global);
} catch (e) { process.exit(2); }
if (!ok) fail();
'

# For tests: check a signature and say how, without installing anything
if [ "${1:-}" = "--verify-signature" ]; then
  if verify_minisign "$2" "$3" "$4"; then echo verified; exit 0; else code=$?; echo "not verified ($code)"; exit "$code"; fi
fi

case "$channel" in stable | beta) ;; *) fail "CAITLYN_CHANNEL must be stable or beta, not $channel" ;; esac

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "this script installs on macOS and Linux; on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "there is no build for $(uname -m)" ;;
esac

if command -v curl > /dev/null 2>&1; then
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }
elif command -v wget > /dev/null 2>&1; then
  fetch() { wget -q --https-only -O "$2" "$1"; }
else
  fail "curl or wget is needed"
fi
# Tests serve releases from this machine over plain http
case "$base" in http://127.0.0.1* | http://localhost*) fetch() { curl -fsSL -o "$2" "$1"; } ;; esac

if command -v sha256sum > /dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum > /dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is needed to check the download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

# The JSON is read with sed, so jq isn't needed: the publisher writes one platform per line (release-manifest.sh).
field() { sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" | head -n 1; }
number() { sed -n "s/.*\"$1\": *\\([0-9][0-9]*\\).*/\\1/p" | head -n 1; }

if [ -n "${CAITLYN_INSTALL_VERSION:-}" ]; then
  version="${CAITLYN_INSTALL_VERSION#v}"
  manifest="$version/manifest.json"
else
  fetch "${base}channels/$channel.json" "$tmp/channel.json" || fail "the $channel channel couldn't be read from $base"
  version="$(field version < "$tmp/channel.json")"
  manifest="$(field manifest < "$tmp/channel.json")"
  [ -n "$manifest" ] || manifest="$version/manifest.json"
  # The stable channel never points at a prerelease
  case "$channel:$version" in stable:*-*) fail "the stable channel points at $version, a prerelease" ;; esac
fi
[ -n "$version" ] || fail "the $channel channel names no version"
case "$version" in *[!0-9A-Za-z.+-]* | .* | *..*) fail "the version $version isn't one" ;; esac
# The manifest is the version's own, at <version>/manifest.json: never a path elsewhere on the host
[ "$manifest" = "$version/manifest.json" ] || fail "the $channel channel names $manifest, not $version's manifest"
# A release's own channel: a prerelease is beta, anything else stable
release_channel=stable
case "$version" in *-*) release_channel=beta ;; esac

fetch "$base$manifest" "$tmp/manifest.json" || fail "the manifest for $version couldn't be read"

# The signature, then the checksum below.
# (The placeholder is spelt in two parts here, so the publisher's substitution leaves this comparison alone.)
unchecked() {
  [ "${CAITLYN_REQUIRE_SIGNATURE:-}" = 1 ] && fail "$1, and CAITLYN_REQUIRE_SIGNATURE=1: nothing was installed"
  say "Warning: $1, so only its SHA-256 and HTTPS protect this download."
}
if [ "$pubkey" = "__MINISIGN_""PUBLIC_KEY__" ]; then
  unchecked "this installer carries no release key (it wasn't published by a release)"
else
  fetch "$base$manifest.minisig" "$tmp/manifest.json.minisig" || fail "the manifest's signature couldn't be read"
  status=0
  verify_minisign "$pubkey" "$tmp/manifest.json" "$tmp/manifest.json.minisig" || status=$?
  case "$status" in
    0) say "Verified the release's signature." ;;
    2) unchecked "the release's signature couldn't be checked: install minisign, OpenSSL 3 or Node.js to check it" ;;
    *) fail "the manifest's signature doesn't match Caitlyn's key: nothing was installed" ;;
  esac
fi

# The signed manifest is the release asked for: a validly signed manifest of another version or channel is refused,
# so an old or beta release can't be served in place of this one
[ "$(field version < "$tmp/manifest.json")" = "$version" ] || fail "the manifest is for $(field version < "$tmp/manifest.json"), not $version: nothing was installed"
[ "$(field channel < "$tmp/manifest.json")" = "$release_channel" ] || fail "the manifest is for the $(field channel < "$tmp/manifest.json") channel, but $version is a $release_channel release: nothing was installed"

line="$(grep "\"os\": *\"$os\"" "$tmp/manifest.json" | grep "\"arch\": *\"$arch\"" | head -n 1)"
[ -n "$line" ] || fail "release $version has no build for $os/$arch"
url="$(printf '%s' "$line" | field url)"
want="$(printf '%s' "$line" | field sha256)"
size="$(printf '%s' "$line" | number size)"
case "$url" in
  https://* | http://127.0.0.1* | http://localhost*) ;;
  */* | *..*) fail "the manifest's archive name $url isn't one" ;;
  *) url="${base}$version/$url" ;;
esac

say "Downloading caitlyn $version for $os/$arch…"
fetch "$url" "$tmp/caitlyn.tar.gz" || fail "the archive couldn't be downloaded"
got_size="$(wc -c < "$tmp/caitlyn.tar.gz" | tr -d ' ')"
[ "$got_size" = "$size" ] || fail "the archive is $got_size bytes, but the manifest says $size: nothing was installed"
got="$(sha256 "$tmp/caitlyn.tar.gz")"
[ "$got" = "$want" ] || fail "the archive's SHA-256 doesn't match the manifest: nothing was installed"

mkdir -p "$tmp/unpacked"
tar -xzf "$tmp/caitlyn.tar.gz" -C "$tmp/unpacked" caitlyn || fail "the archive has no caitlyn binary"
"$tmp/unpacked/caitlyn" version --json > /dev/null 2>&1 || fail "the downloaded binary doesn't start on this machine"

mkdir -p "$dir"
target="$dir/caitlyn"
[ -f "$target" ] && cp "$target" "$target.previous"
cp "$tmp/unpacked/caitlyn" "$target.new"
chmod 0755 "$target.new"
mv -f "$target.new" "$target"

mkdir -p "$config"
chmod 0700 "$config"
cat > "$config/install.json" << EOF
{"method":"script","path":"$target","channel":"$channel","version":"$version","installed":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
chmod 0600 "$config/install.json"

say "Installed caitlyn $version to $target."
case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "Add $dir to your PATH to run it: export PATH=\"$dir:\$PATH\"" ;;
esac
say "Get started: caitlyn auth login"
