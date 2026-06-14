# Hugging Face Spaces (Docker SDK) — PDF 통번역 독립 서버.
# 번역 엔진(lib/pipelines/pdf-translate)만 담은 경량 배포. 메인 보고서 앱과 별개.
FROM node:20-bookworm

# 시스템 의존성: python(pymupdf venv), 폰트 설정, 다운로드 도구.
# (pandoc/canvas 등 보고서용 무거운 의존성은 번역에 불필요 → 미설치)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip fontconfig curl ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*

# node:20 이미지엔 이미 uid 1000 'node' 사용자가 있으므로 그걸 그대로 사용
# (HF Spaces 권장 uid 1000과 동일 — 새로 useradd 하면 UID 충돌로 빌드 실패).
USER node
ENV HOME=/home/node \
    PATH=/home/node/app/bin:/home/node/.local/bin:/usr/local/bin:$PATH \
    NODE_ENV=production \
    PORT=7860 \
    TRANSLATE_PORT=7860 \
    XDG_CACHE_HOME=/home/node/.cache
WORKDIR /home/node/app

# 앱 + 엔진 복사(빌드 컨텍스트는 build-staging.sh 가 만든 최소 세트).
COPY --chown=node:node . /home/node/app

# npm install → postinstall: python venv(pymupdf) + tectonic(재조판) 설치.
RUN npm install

EXPOSE 7860
CMD ["node", "translate-server.js"]
