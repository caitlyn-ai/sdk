#!/bin/sh
# Installs the Smithy CLI release named by SMITHY_VERSION into SMITHY_CLI_DIR and links `smithy`
# onto the PATH. Used by the local Docker image and by the CI jobs (which cache SMITHY_CLI_DIR).
set -eu
: "${SMITHY_VERSION:?SMITHY_VERSION is required}"
dir="${SMITHY_CLI_DIR:-/opt/smithy-cli}"
case "$(uname -m)" in
  aarch64|arm64) arch=aarch64 ;;
  x86_64|amd64) arch=x86_64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
name="smithy-cli-linux-${arch}"
if [ ! -x "${dir}/${SMITHY_VERSION}/${name}/bin/smithy" ]; then
  mkdir -p "${dir}/${SMITHY_VERSION}"
  curl -fsSL -o "${dir}/smithy.zip" "https://github.com/smithy-lang/smithy/releases/download/${SMITHY_VERSION}/${name}.zip"
  unzip -q -o "${dir}/smithy.zip" -d "${dir}/${SMITHY_VERSION}"
  rm "${dir}/smithy.zip"
fi
ln -sf "${dir}/${SMITHY_VERSION}/${name}/bin/smithy" /usr/local/bin/smithy
