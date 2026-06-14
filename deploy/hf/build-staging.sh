#!/usr/bin/env bash
# HF Spaces(Docker) 배포용 최소 스테이징 디렉터리를 만든다(번역에 필요한 파일만).
# 보고서 생성·예시·PII 등은 포함하지 않는다.
# 사용: bash deploy/hf/build-staging.sh [대상디렉터리]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:-$ROOT/tmp/hf-translate-staging}"
rm -rf "$DEST"; mkdir -p "$DEST/public" "$DEST/scripts" "$DEST/lib/pipelines/pdf-translate" "$DEST/lib/fonts"

cp "$ROOT/deploy/hf/Dockerfile"        "$DEST/Dockerfile"
cp "$ROOT/deploy/hf/README.md"         "$DEST/README.md"
cp "$ROOT/deploy/hf/package.json"      "$DEST/package.json"
cp "$ROOT/deploy/hf/requirements.txt"  "$DEST/requirements.txt"
cp "$ROOT/translate-server.js"         "$DEST/translate-server.js"
cp "$ROOT/public/translate-app.html"   "$DEST/public/translate-app.html"
cp "$ROOT/scripts/install-tectonic.sh" "$DEST/scripts/install-tectonic.sh"

for f in translate.js latex-gen.js latex-pdf.js pdf-tool.js translate_pdf.py; do
  cp "$ROOT/lib/pipelines/pdf-translate/$f" "$DEST/lib/pipelines/pdf-translate/$f"
done
cp "$ROOT/lib/anthropic-media.js" "$DEST/lib/anthropic-media.js"
cp "$ROOT/lib/pricing.js"         "$DEST/lib/pricing.js"
cp "$ROOT/lib/json-sanitize.js"   "$DEST/lib/json-sanitize.js"

cp "$ROOT/lib/fonts/NanumGothic-Regular.ttf" "$DEST/lib/fonts/"
cp "$ROOT/lib/fonts/Pretendard-Bold.ttf"     "$DEST/lib/fonts/" 2>/dev/null || true
cp "$ROOT/lib/fonts/Pretendard-Regular.ttf"  "$DEST/lib/fonts/" 2>/dev/null || true

cat > "$DEST/.gitignore" <<'EOF'
node_modules/
.venv/
bin/
*.log
EOF

echo "staged → $DEST"
( cd "$DEST" && find . -type f | sort )
