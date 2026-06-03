#!/usr/bin/env bash
# Render 빌드용: Tectonic(self-contained XeLaTeX) 정적 바이너리를 bin/ 에 설치한다.
# - 재조판(re-typeset) PDF 번역(Claude→LaTeX→Tectonic→PDF)에 필요.
# - 실패해도 빌드는 계속(그 기능만 비활성). PATH 에 이미 있으면(brew 등) 건너뜀.
# - 첫 컴파일 때 TeX 패키지를 받아 캐시하므로 런타임 네트워크가 필요하다.
set -u
VER="0.15.0"

if command -v tectonic >/dev/null 2>&1; then
  echo "tectonic already on PATH — skip"
  exit 0
fi
if [ -x bin/tectonic ]; then
  echo "bin/tectonic already present — skip"
  exit 0
fi

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64)   ASSET="tectonic-${VER}-x86_64-unknown-linux-musl.tar.gz" ;;
  Linux-aarch64)  ASSET="tectonic-${VER}-aarch64-unknown-linux-gnu.tar.gz" ;;
  Darwin-arm64)   ASSET="tectonic-${VER}-aarch64-apple-darwin.tar.gz" ;;
  Darwin-x86_64)  ASSET="tectonic-${VER}-x86_64-apple-darwin.tar.gz" ;;
  *) echo "no tectonic prebuilt for $OS-$ARCH — skip"; exit 0 ;;
esac
URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VER}/${ASSET}"

mkdir -p bin
echo "downloading tectonic ${VER} ($ASSET)..."
if curl -fsSL --max-time 120 "$URL" | tar xz -C bin tectonic; then
  chmod +x bin/tectonic
  echo "tectonic installed → bin/tectonic"
else
  echo "WARN: tectonic download failed — re-typeset PDF will be unavailable"
fi
