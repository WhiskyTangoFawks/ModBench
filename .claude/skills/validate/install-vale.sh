#!/usr/bin/env bash
# Puts the pinned Vale release at tools/vale/vale (gitignored). Prints the binary path.
set -euo pipefail
VERSION=3.20.0
SHA256=f59e7030c5d4ace6cf915497d0d076a1699d61e876142765963237e6867c9712
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$ROOT/tools/vale"
BIN="$DIR/vale"

if [[ -x "$BIN" ]] && [[ "$("$BIN" --version)" == "vale version $VERSION" ]]; then
  echo "$BIN"; exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  ASSET="vale_${VERSION}_Linux_64-bit.tar.gz" ;;
  Linux-aarch64) ASSET="vale_${VERSION}_Linux_arm64.tar.gz" ;;
  Darwin-x86_64) ASSET="vale_${VERSION}_macOS_64-bit.tar.gz" ;;
  Darwin-arm64)  ASSET="vale_${VERSION}_macOS_arm64.tar.gz" ;;
  *) echo "install-vale: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$DIR"
TARBALL="$DIR/$ASSET"
curl -fsSL -o "$TARBALL" "https://github.com/errata-ai/vale/releases/download/v${VERSION}/${ASSET}"
if [[ "$ASSET" == "vale_${VERSION}_Linux_64-bit.tar.gz" ]]; then
  echo "$SHA256  $TARBALL" | sha256sum -c --quiet
fi
tar -xzf "$TARBALL" -C "$DIR" vale
rm -f "$TARBALL"
echo "$BIN"
