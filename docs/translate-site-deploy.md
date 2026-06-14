# PDF 통번역 독립 사이트 배포 가이드

메인 보고서 사이트(`server.js`)와 **같은 repo·별도 Render 서비스**로 돌아가는
PDF 통번역 전용 사이트다. 메인 사이트 코드는 건드리지 않는다.

- 엔트리: `translate-server.js` (start: `node translate-server.js` 또는 `npm run start:translate`)
- UI: `public/translate-app.html`
- 엔진: `lib/pipelines/pdf-translate/*` 를 메인과 **공유**(단일 소스)
- 접근: 비밀번호/초대코드(`TRANSLATE_ACCESS_CODES`)

## Render에 새 서비스 만들기

1. Render → **New +** → **Web Service** → 이 repo 선택(메인과 같은 repo).
2. 설정:
   - **Build Command**: `npm install`
     (postinstall이 메인과 동일하게 python venv + PyMuPDF + Tectonic + pandoc 설치 — 재조판/OCR에 필요)
   - **Start Command**: `node translate-server.js`
   - **Instance Type**: 메인과 동일 이상(PyMuPDF/Tectonic 메모리 때문에 무료티어는 빠듯할 수 있음)
3. **Environment** 변수:

   | 키 | 값 | 필수 |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | Claude 키 | ✅ |
   | `GPT_API_KEY` | OpenAI 키(= GPT 모델 쓸 때) | 선택 |
   | `TRANSLATE_ACCESS_CODES` | `code1,code2` (쉼표구분 초대코드) | ✅(프로덕션) |
   | `TRANSLATE_SESSION_SECRET` | 쿠키 서명용 랜덤 문자열 | 권장 |
   | `NODE_ENV` | `production` | 권장 |
   | `PORT` | (Render가 자동 주입) | — |

   > `TRANSLATE_ACCESS_CODES` 미설정 + `NODE_ENV=production` 이면 **모든 접근이 차단**된다(안전 기본값). 로컬(비프로덕션)에서 코드 미설정이면 게이트 없이 열림.

4. 배포 후 사이트 접속 → 초대코드 입력 → PDF 업로드 → 번역.

## 튜닝 환경변수(선택, 메인과 공유)

`PDF_TRANSLATE_TIMEOUT_MS`(기본 20분), `PDF_TRANSLATE_MAX_PAGES`(80),
`PDF_OCR_MAX_PAGES`(30), `PDF_AUTO_MATH_THRESHOLD`(12),
`PDF_RETYPESET_CHUNK_PAGES`(5), `PDF_TRANSLATE_CONCURRENCY`,
`PDF_RETYPESET_CONCURRENCY`, `PDF_TRANSLATE_MODEL`(기본 모델).

## 도메인

Render 서비스에 커스텀 도메인 연결 가능(서비스 → Settings → Custom Domains).

## 로컬 점검

```bash
# 게이트 없이(개발):
TRANSLATE_PORT=4100 node translate-server.js
# 코드 게이트:
NODE_ENV=production TRANSLATE_ACCESS_CODES=hunter2 TRANSLATE_PORT=4100 node translate-server.js
```

## 메인 사이트 영향

없음. `server.js`/보고서 파이프라인은 변경하지 않았다. 메인 서비스는 기존
`node server.js` 그대로 배포된다(이 repo에 파일이 추가돼도 main 서비스 동작 불변).
PDF 통번역 엔진(`lib/pipelines/pdf-translate/`)은 두 서비스가 공유하므로,
엔진을 고치면 양쪽에 동시에 반영된다.
