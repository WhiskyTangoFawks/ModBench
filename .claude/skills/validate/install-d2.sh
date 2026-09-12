#!/usr/bin/env bash
# Puts the pinned d2 release at tools/d2/d2 (gitignored). Prints the binary path.
set -euo pipefail
VERSION=0.9.0
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$ROOT/tools/d2"
BIN="$DIR/d2"

if [[ -x "$BIN" ]] && [[ "$("$BIN" --version)" == "v$VERSION" ]]; then
  echo "$BIN"; exit 0
fi

PLATFORM="$(uname -s)-$(uname -m)"
case "$PLATFORM" in
  Linux-x86_64)  ASSET="linux-amd64"; SHA256=5669ddc46b99e942cc96078f4a4e36d5e62103348f4c05179ede27802fdd87a9 ;;
  Linux-aarch64) ASSET="linux-arm64"; SHA256=ac2c028697199479acb321db1e3d68caee9f2ba492ed73caa3cd13f3829bf913 ;;
  Darwin-x86_64) ASSET="macos-amd64"; SHA256=cad39576a480d6bb02ea142fef1726647914b0d2da51ccc9b30b660a2b1babf0 ;;
  Darwin-arm64)  ASSET="macos-arm64"; SHA256=eaf6c0c143e56dd9fa97bfb6df25ea9c1ebce40245f056a0768cf1a6c15d3064 ;;
  *) echo "install-d2: unsupported platform $PLATFORM" >&2; exit 1 ;;
esac
ASSET_TGZ="d2-v${VERSION}-${ASSET}.tar.gz"

mkdir -p "$DIR"
TARBALL="$DIR/$ASSET_TGZ"
curl -fsSL -o "$TARBALL" "https://github.com/d2lang/d2/releases/download/v${VERSION}/${ASSET_TGZ}"
echo "$SHA256  $TARBALL" | sha256sum -c --quiet
tar -xzf "$TARBALL" -C "$DIR" --strip-components=2 "d2-v${VERSION}/bin/d2"
rm -f "$TARBALL"
echo "$BIN"
