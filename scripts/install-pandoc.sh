#!/usr/bin/env bash
# Render 빌드용: pandoc 정적 바이너리를 bin/ 에 설치한다.
# - docx → hwpx 변환(pypandoc-hwpx)이 pandoc 을 필요로 한다.
# - 실패해도 빌드는 계속(그 기능만 비활성). PATH 에 이미 있으면(brew 등) 건너뜀.
set -u
VER="3.5"

if command -v pandoc >/dev/null 2>&1; then
  echo "pandoc already on PATH — skip"
  exit 0
fi
if [ -x bin/pandoc ]; then
  echo "bin/pandoc already present — skip"
  exit 0
fi

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64)   ASSET="pandoc-${VER}-linux-amd64.tar.gz" ;;
  Linux-aarch64)  ASSET="pandoc-${VER}-linux-arm64.tar.gz" ;;
  *) echo "no pandoc prebuilt for $OS-$ARCH — skip"; exit 0 ;;
esac
URL="https://github.com/jgm/pandoc/releases/download/${VER}/${ASSET}"

mkdir -p bin
TMP="$(mktemp -d)"
echo "downloading pandoc ${VER} ($ASSET)..."
if curl -fsSL --max-time 180 "$URL" | tar xz -C "$TMP"; then
  # tar 안 구조: pandoc-<VER>/bin/pandoc
  BIN="$(find "$TMP" -type f -name pandoc | head -1)"
  if [ -n "$BIN" ]; then
    cp "$BIN" bin/pandoc && chmod +x bin/pandoc
    echo "pandoc installed → bin/pandoc"
  else
    echo "WARN: pandoc binary not found in archive — docx→hwpx unavailable"
  fi
else
  echo "WARN: pandoc download failed — docx→hwpx will be unavailable"
fi
rm -rf "$TMP"
