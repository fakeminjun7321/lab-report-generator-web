// PDF 통번역 오케스트레이션.
//   1) translate_pdf.py 로 번역 대상 문단 추출
//   2) Claude 로 문단을 묶음 단위 번역 (한국어)
//   3) translate_pdf.py 로 번역문을 원본 레이아웃에 삽입
// 그림·도표·벡터 그래픽은 건드리지 않으므로 그대로 보존된다.
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { calcCost } = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const tool = require("./pdf-tool");

const FONT_PATH = path.join(__dirname, "../../fonts/NanumGothic-Regular.ttf");

// 번역 기본 모델: 문서 번역엔 Sonnet 으로 충분하고 빠르다(비용↓). 환경변수로 변경 가능.
const DEFAULT_MODEL = process.env.PDF_TRANSLATE_MODEL || "claude-sonnet-4-6";
// 페이지 상한 — 비용/시간 폭주 방지(관리자 테스트 기본 80쪽).
const MAX_PAGES = parseInt(process.env.PDF_TRANSLATE_MAX_PAGES || "80", 10);
// 한 번의 Claude 요청에 묶을 대략적 글자 수.
const BATCH_CHARS = parseInt(process.env.PDF_TRANSLATE_BATCH_CHARS || "3500", 10);
// 묶음 동시 번역 수 — 순차로 하면 페이지 많을 때 타임아웃. 5개 동시면 ~5배 빠름.
const CONCURRENCY = parseInt(process.env.PDF_TRANSLATE_CONCURRENCY || "5", 10);

const SYSTEM_PROMPT = [
  "You are a professional translator specializing in academic and technical/scientific documents",
  "(lab manuals, papers, textbooks). Translate each given text segment into natural, fluent Korean (한국어).",
  "",
  "Rules:",
  "- Translate faithfully. Do NOT summarize, add, drop, or merge content.",
  "- Preserve exactly: numbers, units, math/chemical formulas, variable names, equation symbols, code, URLs, citations,",
  "  and proper nouns that are conventionally left untranslated.",
  "- Use accurate Korean scientific/technical terminology.",
  "- Translate each id independently.",
  "- If a segment is already Korean, or is only symbols/numbers, return it unchanged.",
  '- Output MUST be a single JSON object and nothing else: {"t": {"<id>": "<korean>", ...}} including every id given.',
].join("\n");

function buildBatches(blocks, maxChars = BATCH_CHARS) {
  const batches = [];
  let cur = [];
  let curChars = 0;
  for (const b of blocks) {
    cur.push(b);
    curChars += (b.text || "").length;
    if (curChars >= maxChars) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

async function translateBatch(client, model, blocks, signal) {
  const items = blocks.map((b) => ({ id: b.id, text: b.text }));
  const userContent =
    "Translate the following segments to Korean. Return only the JSON object described.\n\n" +
    JSON.stringify(items, null, 0);

  // 출력이 잘리면 JSON 파싱 실패로 묶음 전체가 누락된다. 한국어가 원문보다 길 수
  // 있고 긴 단일 블록도 있으므로, 입력 길이에 맞춰 출력 한도를 키운다(실제 출력
  // 토큰만 과금되므로 비용 영향 없음).
  const inputChars = items.reduce((s, it) => s + (it.text || "").length, 0);
  const maxTokens = Math.min(32000, Math.max(8000, Math.ceil(inputChars * 2.5)));

  const message = await client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      system: [
        // 정적 시스템 프롬프트 → 5분 ephemeral 캐시로 묶음 간 입력 비용 절감.
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userContent }],
    },
    signal ? { signal } : undefined,
  );

  const text = (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // {"t":{id:ko}} 가 정상. 모델이 {id:ko} 를 바로 주면 그것도 받되, 배열 등
  // 예상 외 형태는 무시(아래 mergeResult 가 문자열 값만 채택).
  // ⚠ 모델이 ```json 펜스나 앞뒤 설명을 붙이면 raw JSON.parse 가 실패해 그 묶음의
  //   모든 문단이 통째로 누락된다 → 펜스/객체 범위를 먼저 추출한다(누락 주원인 수정).
  let map = {};
  try {
    const parsed = parseJsonLenient(extractJsonText(text));
    if (isPlainObject(parsed) && isPlainObject(parsed.t)) map = parsed.t;
    else if (isPlainObject(parsed)) map = parsed;
  } catch {
    map = {};
  }
  return { map, usage: message.usage };
}

// 모델 응답에서 JSON 만 뽑는다: ```json 펜스 → 펜스 내부, 아니면 첫 '{'~마지막 '}'.
function extractJsonText(text) {
  const s = String(text || "");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first !== -1 && last > first) return body.slice(first, last + 1).trim();
  return body.trim();
}

/**
 * PDF 를 한국어로 통번역한다.
 * @returns {Promise<{buffer:Buffer, cost:Object, pageCount:number, scanned:boolean,
 *                    blockCount:number, missing:number, stats:{replaced:number, shrunk:number}}>}
 */
async function translatePdf({
  pdfBuffer,
  model = null,
  onProgress = () => {},
  signal,
}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  const MODEL = model || DEFAULT_MODEL;

  const base = path.join(
    os.tmpdir(),
    `pdftr-${crypto.randomBytes(8).toString("hex")}`,
  );
  const inPath = `${base}.pdf`;
  const outPath = `${base}.ko.pdf`;
  fs.writeFileSync(inPath, pdfBuffer);

  try {
    onProgress(`🤖 번역 모델: ${MODEL}`);
    onProgress("📄 PDF 분석 중 (텍스트 추출)...");
    const { page_count, scanned, blocks } = await tool.extractBlocks(inPath, {
      signal,
    });

    if (page_count > MAX_PAGES) {
      throw new Error(
        `페이지가 너무 많습니다 (${page_count}쪽 > 상한 ${MAX_PAGES}쪽). 파일을 나눠서 시도하세요.`,
      );
    }
    if (!blocks.length) {
      if (scanned) {
        throw new Error(
          "추출 가능한 텍스트가 없습니다. 스캔본(글자가 이미지인 PDF)으로 보입니다 — 현재 버전은 텍스트 레이어가 있는 PDF만 지원합니다(OCR 미지원).",
        );
      }
      throw new Error("번역할 텍스트를 찾지 못했습니다.");
    }
    if (scanned) {
      onProgress(
        "⚠ 텍스트가 매우 적습니다 — 일부가 스캔 이미지일 수 있어 그 부분은 번역되지 않습니다.",
      );
    }
    onProgress(`✓ ${page_count}쪽, 번역 대상 ${blocks.length}개 문단`);

    const batches = buildBatches(blocks);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const translations = {};
    const usageSum = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };

    const mergeResult = (map, usage) => {
      for (const [k, v] of Object.entries(map || {})) {
        if (typeof v === "string" && v.trim()) translations[String(k)] = v;
      }
      if (usage) {
        usageSum.input_tokens += usage.input_tokens || 0;
        usageSum.output_tokens += usage.output_tokens || 0;
        usageSum.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
        usageSum.cache_creation_input_tokens +=
          usage.cache_creation_input_tokens || 0;
      }
    };

    // 묶음을 동시에 번역(기본 5개). 순차로 하면 페이지 많을 때 타임아웃 난다.
    const runBatches = async (batchList, label) => {
      let next = 0;
      let done = 0;
      const total = batchList.length;
      const worker = async () => {
        for (;;) {
          if (signal?.aborted) throw new Error("작업이 중단되었습니다.");
          const i = next++;
          if (i >= total) return;
          try {
            const { map, usage } = await translateBatch(
              client,
              MODEL,
              batchList[i],
              signal,
            );
            mergeResult(map, usage);
          } catch (e) {
            // 중단은 전체 전파. 그 외(일시적 API 오류 등)는 이 묶음만 건너뛰고
            // 계속 — 누락 문단은 뒤의 재시도 패스가 다시 시도한다(다른 워커가
            // 계속 돌아 청구·진행이 멈추지 않게).
            if (signal?.aborted) throw e;
            onProgress(`⚠ 묶음 ${i + 1} 실패 — 누락분 재시도에서 다시 시도`);
          }
          done += 1;
          onProgress(`${label} (${done}/${total} 묶음)`);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()),
      );
    };

    await runBatches(batches, "🌐 번역 중...");

    // 누락 문단 재시도 — 점점 작은 묶음으로 여러 번(파싱 실패가 묶음 전체를 날리지
    // 않도록), 마지막엔 문단당 1개씩. 결과물에 원문(영어)이 남지 않도록.
    let missingBlocks = blocks.filter((b) => !translations[String(b.id)]);
    for (const size of [1500, 1]) {
      if (!missingBlocks.length) break;
      onProgress(`🔁 누락 ${missingBlocks.length}개 문단 재번역 시도...`);
      await runBatches(buildBatches(missingBlocks, size), "🔁 재시도");
      missingBlocks = blocks.filter((b) => !translations[String(b.id)]);
    }

    if (Object.keys(translations).length === 0) {
      throw new Error(
        "번역 결과를 받지 못했습니다(모델 응답 파싱 실패). 잠시 후 다시 시도하세요.",
      );
    }

    const missing = missingBlocks.length;
    if (missing) {
      onProgress(`⚠ ${missing}개 문단은 번역 실패로 원문 유지`);
    }

    onProgress("🖋 번역문을 원본 레이아웃에 삽입 중...");
    const stats = await tool.renderTranslated(
      inPath,
      outPath,
      FONT_PATH,
      translations,
      { signal },
    );
    const buffer = fs.readFileSync(outPath);
    onProgress(
      `✓ 레이아웃 삽입 완료 (교체 ${stats.replaced}곳${stats.shrunk ? `, 자동 축소 ${stats.shrunk}곳` : ""})`,
    );

    const cost = calcCost({ usage: usageSum, model: MODEL });

    return {
      buffer,
      cost,
      pageCount: page_count,
      scanned: !!scanned,
      blockCount: blocks.length,
      missing,
      stats,
    };
  } finally {
    for (const p of [inPath, outPath]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

module.exports = { translatePdf, DEFAULT_MODEL, MAX_PAGES };
