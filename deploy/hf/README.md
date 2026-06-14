---
title: PDF 통번역
emoji: 📄
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: DeepL식 PDF 문서 번역 (그림·레이아웃 유지, 텍스트만 한국어)
---

# PDF 통번역

그림·표·레이아웃은 그대로 두고 **텍스트만 한국어로** 바꾼 PDF를 돌려줍니다.
수식 많은 논문·스캔본은 자동으로 재조판/OCR 처리합니다. 외부 전송 없이 서버에서만 처리.

접근은 **초대코드**(`TRANSLATE_ACCESS_CODES`)로 제한됩니다.

## 필요한 Secrets (Space → Settings → Variables and secrets)

| 키 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API 키 (필수) |
| `GPT_API_KEY` | OpenAI 키 (GPT 모델 쓸 때, 선택) |
| `TRANSLATE_ACCESS_CODES` | 초대코드 `code1,code2` (필수) |
| `TRANSLATE_SESSION_SECRET` | 쿠키 서명용 랜덤 문자열 (권장) |
