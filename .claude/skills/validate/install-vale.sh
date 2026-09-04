#!/usr/bin/env bash
# Puts the pinned Vale release at tools/vale/vale (gitignored). Prints the binary path.
set -euo pipefail
VERSION=3.20.0
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$ROOT/tools/vale"
BIN="$DIR/vale"

if [[ -x "$BIN" ]] && [[ "$("$BIN" --version)" == "vale version $VERSION" ]]; then
  echo "$BIN"; exit 0
fi

PLATFORM="$(uname -s)-$(uname -m)"
case "$PLATFORM" in
  Linux-x86_64)  ASSET="Linux_64-bit"; SHA256=f59e7030c5d4ace6cf915497d0d076a1699d61e876142765963237e6867c9712 ;;
  Linux-aarch64) ASSET="Linux_arm64";  SHA256=d49e89479a40dbe6a6fe44a2963abef0ee39d89453f3c7100bdd1c5dd0708961 ;;
  Darwin-x86_64) ASSET="macOS_64-bit"; SHA256=8d51cbe9ca6274fade890fc943b30dc564071dcb8fd8814abce2d0dca37fbba7 ;;
  Darwin-arm64)  ASSET="macOS_arm64";  SHA256=6b32df1a7d7b2ab01c07c1c4dd5fd84d775ac7a8f4101084cb5cc7df76bdc65e ;;
  *) echo "install-vale: unsupported platform $PLATFORM" >&2; exit 1 ;;
esac
ASSET="vale_${VERSION}_${ASSET}.tar.gz"

mkdir -p "$DIR"
TARBALL="$DIR/$ASSET"
curl -fsSL -o "$TARBALL" "https://github.com/errata-ai/vale/releases/download/v${VERSION}/${ASSET}"
echo "$SHA256  $TARBALL" | sha256sum -c --quiet
tar -xzf "$TARBALL" -C "$DIR" vale
rm -f "$TARBALL"
echo "$BIN"
