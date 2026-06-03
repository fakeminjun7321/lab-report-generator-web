// 재조판(re-typeset) 번역: PDF(또는 스캔본 페이지 이미지)를 Claude 에게 주고
// "한국어 LaTeX 본문"을 받아 Tectonic 으로 PDF 를 만든다. 스캔본일 때는 Claude 가
// 그림 위치(%%FIG:n%% 마커)와 bbox(JSON)를 함께 알려주면, 원본 타일에서 그 영역을
// 잘라 \includegraphics 로 다시 끼워넣는다(그림 복원형 재조판).
const Anthropic = require("@anthropic-ai/sdk");
const sharp = require("sharp");
const { calcCost } = require("../../pricing");
const { buildTex, compileTex } = require("./latex-pdf");

const DEFAULT_MODEL = process.env.PDF_RETYPESET_MODEL || "claude-opus-4-8";
const MAX_TOKENS = parseInt(process.env.PDF_RETYPESET_MAX_TOKENS || "32000", 10);
const MAX_PDF_BYTES = 25 * 1024 * 1024;

const SYSTEM_PROMPT = [
  "You are an expert academic translator AND LaTeX typesetter. You receive a document (a PDF, or ordered page-image slices of a scanned document) and produce a faithful KOREAN re-typeset of it as LaTeX.",
  "",
  "CRITICAL — equations:",
  "- The source math is often CORRUPTED or hard to read (Greek letters, primes, roots, subscripts lost or turned into junk). Do NOT copy garbled math. Reconstruct each formula into its mathematically-correct canonical form and typeset it in proper LaTeX. You know the standard form of well-known equations — restore them faithfully.",
  "- Use \\[ ... \\] for display equations and $...$ for inline math. amsmath/amssymb are available.",
  "",
  "Translation:",
  "- Translate ALL prose into natural, fluent academic Korean (학술 문어체). Keep numbers, units, variable names, and proper nouns accurate.",
  "- Preserve the document's structure: use \\section*{...} / \\subsection*{...} for headings, normal paragraphs for body. Keep the original numbering of problems/items.",
  "- Translate the whole document, in order. Do not summarize or drop content.",
  "",
  "Tables — IMPORTANT:",
  "- Reproduce every table as a real LaTeX table using \\begin{tabular}{...} ... \\end{tabular} (use \\hline for rules). Keep ALL rows and columns; translate header/cell text to Korean but keep numbers/units exact. Align numeric columns. Do NOT flatten a table into a paragraph or a list.",
  "- For wide tables, you may use a smaller font (\\small or \\footnotesize) so they fit the page width.",
  "",
  "Output format — IMPORTANT:",
  "- Output ONE ```latex code block (the document BODY).",
  "- The FIRST three lines of that block must be metadata comments:",
  "    % TITLE: <Korean title>",
  "    % AUTHOR: <author, may be empty>",
  "    % DATE: <date, may be empty>",
  "- After those, output ONLY the LaTeX BODY (what goes inside \\begin{document}…\\end{document}). Do NOT include \\documentclass, \\usepackage, the preamble, \\begin{document}, \\end{document}, \\title, \\author, \\date, or \\maketitle — those are added automatically.",
  "- Use only packages already loaded: amsmath, amssymb, graphicx. Do not \\usepackage anything.",
  "- Figures: follow the figure instructions in the user message exactly (use %%FIG:n%% markers + a JSON list). Do NOT invent \\includegraphics yourself.",
].join("\n");

const IMAGE_INSTRUCTIONS = [
  "위 이미지들은 한 문서를 위에서 아래 순서로 자른 페이지 조각입니다(1번부터 순서대로 제공; 경계가 약간 겹칠 수 있으니 중복된 문장은 한 번만 쓰세요).",
  "전체를 하나의 문서로 보고 다음을 수행하세요:",
  "1) 모든 본문을 자연스러운 한국어 학술 문어체로 번역하고, 수식을 정준형 LaTeX 로 복원해 재조판하세요. 문제 번호 등 원본 번호 체계를 유지하세요.",
  "2) 그림·도식·그래프·표 이미지가 있으면, 본문에서 그 그림이 와야 할 자리에 정확히 `%%FIG:n%%` 한 줄을 넣으세요(n = 1,2,3…). 그림을 말로 설명하지 말고 마커만 넣습니다.",
  "3) ```latex 블록을 닫은 뒤, 그림 목록을 ```json 블록 하나로 출력하세요. 형식:",
  '   [{"n":1,"image":3,"box":[x0,y0,x1,y1],"caption":"그림 P9.5"}]',
  "   - image: 그 그림이 보이는 페이지 이미지 번호(내가 준 순서, 1부터).",
  "   - box: 그 이미지 안에서 그림의 위치를 0~1 비율로 [좌, 상, 우, 하]. 이미지의 왼쪽 위가 (0,0), 오른쪽 아래가 (1,1). 그림(선·도형·축·사진)만 단단히 감싸되 가장자리가 잘리지 않게 살짝만 여유를 두세요. 그림 옆/아래의 본문 문단 글자는 box 에 넣지 마세요(캡션 한 줄 정도는 포함 가능).",
  "   - caption: 원본 그림 번호/제목(예: 그림 P9.5). 없으면 \"\".",
  "   그림이 하나도 없으면 빈 배열 [] 을 출력하세요.",
  "위 시스템 출력 형식(메타 3줄 + 본문)도 정확히 지키세요.",
].join("\n");

function parseLatexOutput(text) {
  // 첫 ```latex ... ``` 코드블록 추출(없으면 전체에서 json 블록만 제거)
  const m = text.match(/```(?:latex|tex)?\s*([\s\S]*?)```/i);
  let block = (m ? m[1] : text).trim();
  const meta = { title: "", author: "", date: "" };
  const lines = block.split("\n");
  const rest = [];
  for (const line of lines) {
    const mt = line.match(/^\s*%\s*(TITLE|AUTHOR|DATE)\s*:\s*(.*)$/i);
    if (mt && !rest.length) {
      meta[mt[1].toLowerCase()] = mt[2].trim();
    } else {
      rest.push(line);
    }
  }
  return { ...meta, body: rest.join("\n").trim() };
}

// Claude 출력에서 그림 목록 JSON 블록을 파싱. 실패하면 빈 배열.
function parseFiguresJson(text) {
  // ```json ... ``` 우선, 없으면 본문 뒤쪽의 [ ... ] 배열 시도
  let raw = null;
  const j = text.match(/```json\s*([\s\S]*?)```/i);
  if (j) raw = j[1];
  else {
    // latex 블록 이후 마지막 대괄호 배열
    const after = text.split(/```/).pop();
    const a = after && after.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (a) raw = a[0];
  }
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw.trim());
    if (!Array.isArray(arr)) return [];
    return arr
      .map((f) => ({
        n: parseInt(f.n, 10),
        image: parseInt(f.image, 10),
        box: Array.isArray(f.box) ? f.box.map(Number) : null,
        caption: String(f.caption || "").trim(),
      }))
      .filter(
        (f) =>
          Number.isFinite(f.n) &&
          Number.isFinite(f.image) &&
          f.box &&
          f.box.length === 4 &&
          f.box.every((v) => Number.isFinite(v)),
      );
  } catch {
    return [];
  }
}

function escapeLatex(s) {
  return String(s)
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

const clamp01 = (v) => {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
};

// figures + 원본 타일 버퍼 → {assets:[{name,buffer}], replace:{n: latex}}.
// sharp 로 bbox 영역을 잘라 PNG 에셋으로 만든다.
async function cropFigures(figures, tiles) {
  const assets = [];
  const replace = {};
  for (const f of figures) {
    const tile = tiles[f.image - 1];
    if (!tile) continue;
    const box = f.box.map(clamp01);
    if (box.some((v) => v === null)) continue;
    let [x0, y0, x1, y1] = box;
    if (x1 - x0 < 0.02 || y1 - y0 < 0.02) continue; // 너무 작음
    // 가장자리 잘림 방지용 여백(box 의 1.5%, 최대 0.03) — bbox 가 약간 빡빡해도 안전.
    const padX = Math.min(0.03, (x1 - x0) * 0.015);
    const padY = Math.min(0.03, (y1 - y0) * 0.015);
    x0 = clamp01(x0 - padX);
    y0 = clamp01(y0 - padY);
    x1 = clamp01(x1 + padX);
    y1 = clamp01(y1 + padY);
    try {
      const meta = await sharp(tile).metadata();
      const W = meta.width || 0;
      const H = meta.height || 0;
      if (!W || !H) continue;
      const left = Math.max(0, Math.round(x0 * W));
      const top = Math.max(0, Math.round(y0 * H));
      const width = Math.min(W - left, Math.round((x1 - x0) * W));
      const height = Math.min(H - top, Math.round((y1 - y0) * H));
      if (width < 8 || height < 8) continue;
      const buf = await sharp(tile)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
      const name = `fig-${f.n}.png`;
      assets.push({ name, buffer: buf });
      const cap = escapeLatex(f.caption);
      replace[f.n] =
        `\\begin{center}\n\\includegraphics[width=0.7\\linewidth,height=0.4\\textheight,keepaspectratio]{${name}}` +
        (cap ? `\\\\\n{\\small ${cap}}` : "") +
        `\n\\end{center}`;
    } catch {
      /* 이 그림만 건너뜀 */
    }
  }
  return { assets, replace };
}

// 본문의 %%FIG:n%% 마커를 그림(또는 빈 문자열)로 치환.
function injectFigures(body, replace) {
  return body.replace(/%%FIG:(\d+)%%/g, (_m, n) => replace[n] || "");
}

/**
 * PDF(또는 스캔본 타일) → 재조판 한국어 PDF(Buffer).
 * @param {Buffer[]} [tiles] 스캔본 원본 PNG 타일 버퍼(imageBlocks 와 같은 순서) — 그림 복원용.
 * @returns {Promise<{buffer:Buffer, cost:Object, model:string, figures:number}>}
 */
async function retypesetPdf({
  pdfBuffer,
  pdfChunks = null,
  imageBlocks = null,
  tiles = null,
  model = null,
  onProgress = () => {},
  signal,
}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  const useImages = Array.isArray(imageBlocks) && imageBlocks.length > 0;
  const useChunks =
    !useImages && Array.isArray(pdfChunks) && pdfChunks.length > 1;
  if (!useImages && !useChunks && pdfBuffer.length > MAX_PDF_BYTES) {
    throw new Error("PDF 가 너무 큽니다(25MB 초과).");
  }
  const MODEL = model || DEFAULT_MODEL;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  onProgress(`🤖 재조판 번역 모델: ${MODEL}`);

  const TEXT_INSTR =
    "이 PDF 문서를 한국어로 충실히 번역하고, 수식을 정준형으로 복원해 LaTeX 본문으로 재조판하세요. 위 출력 형식을 정확히 지키세요.";
  const docBlock = (buf) => ({
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: buf.toString("base64"),
    },
  });

  const usageSum = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const addUsage = (u) => {
    if (!u) return;
    usageSum.input_tokens += u.input_tokens || 0;
    usageSum.output_tokens += u.output_tokens || 0;
    usageSum.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    usageSum.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  };
  // 한 입력(userContent) → Claude → { text, usage, truncated }
  const callClaude = async (userContent) => {
    const message = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: userContent }],
      },
      signal ? { signal } : undefined,
    );
    addUsage(message.usage);
    return {
      truncated: message.stop_reason === "max_tokens",
      text: (message.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
    };
  };

  let body = "";
  let title = "";
  let author = "";
  let date = "";
  let assets = [];
  let figureCount = 0;

  if (useChunks) {
    // 페이지 구간을 동시에 번역한 뒤 본문을 순서대로 이어붙인다(Opus 품질 유지, 속도↑).
    onProgress(`⚡ ${pdfChunks.length}개 구간으로 나눠 병렬 번역 중...`);
    const CONC = Math.max(
      1,
      parseInt(process.env.PDF_RETYPESET_CONCURRENCY || "4", 10),
    );
    const parts = new Array(pdfChunks.length).fill(null);
    let idx = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        if (signal?.aborted) throw new Error("작업이 중단되었습니다.");
        const i = idx++;
        if (i >= pdfChunks.length) return;
        let lastErr = null;
        for (let attempt = 0; attempt < 2 && parts[i] == null; attempt++) {
          try {
            const r = await callClaude([
              docBlock(pdfChunks[i]),
              { type: "text", text: TEXT_INSTR },
            ]);
            parts[i] = parseLatexOutput(r.text);
          } catch (e) {
            if (signal?.aborted) throw e;
            lastErr = e;
          }
        }
        if (parts[i] == null) {
          throw new Error(
            `구간 ${i + 1}/${pdfChunks.length} 번역 실패: ${lastErr ? lastErr.message : "알 수 없음"}`,
          );
        }
        done += 1;
        onProgress(`⚡ 병렬 번역 (${done}/${pdfChunks.length} 구간 완료)`);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONC, pdfChunks.length) }, () => worker()),
    );
    const meta = parts.find((p) => p && (p.title || p.author || p.date)) || parts[0] || {};
    title = meta.title || "";
    author = meta.author || "";
    date = meta.date || "";
    body = parts
      .map((p) => (p ? injectFigures(p.body, {}) : ""))
      .filter((b) => b && b.trim())
      .join("\n\n");
    if (!body || body.length < 20) {
      throw new Error("재조판 본문을 받지 못했습니다.");
    }
  } else {
    // 단일 호출 — 스캔본 이미지(그림 복원 포함) 또는 작은 텍스트 PDF.
    onProgress(
      useImages
        ? `🔎 스캔본 OCR: 고해상도 페이지 이미지 ${imageBlocks.length}장을 읽는 중...`
        : "📖 문서를 읽고 한국어로 재조판(수식 복원) 중...",
    );
    const userContent = useImages
      ? [...imageBlocks, { type: "text", text: IMAGE_INSTRUCTIONS }]
      : [docBlock(pdfBuffer), { type: "text", text: TEXT_INSTR }];
    const r = await callClaude(userContent);
    if (r.truncated) {
      throw new Error(
        "문서가 너무 길어 LaTeX 출력이 잘렸습니다. 더 짧은 PDF로 나눠 시도하세요.",
      );
    }
    const parsed = parseLatexOutput(r.text);
    body = parsed.body;
    title = parsed.title;
    author = parsed.author;
    date = parsed.date;
    if (!body || body.length < 20) {
      throw new Error("재조판 LaTeX 본문을 받지 못했습니다.");
    }
    // 그림 복원: 스캔본 타일이 있으면 bbox 로 잘라 \includegraphics 로 주입.
    if (useImages && Array.isArray(tiles) && tiles.length) {
      const figures = parseFiguresJson(r.text);
      if (figures.length) {
        const cropped = await cropFigures(figures, tiles);
        assets = cropped.assets;
        figureCount = assets.length;
        body = injectFigures(body, cropped.replace);
        if (figureCount) onProgress(`🖼️ 원본 그림 ${figureCount}개 복원해 삽입`);
      }
    }
    body = injectFigures(body, {}); // 남은 마커 제거(raw 노출 방지)
  }

  onProgress("📐 LaTeX → PDF 컴파일 중...");
  const tex = buildTex({ body, title, author, date });
  let buffer;
  try {
    buffer = await compileTex(tex, { signal, onProgress, assets });
  } catch (e) {
    console.error("[retypeset] tectonic compile failed:", e.message);
    throw new Error(`재조판 PDF 생성 실패: ${e.message}`);
  }

  const cost = calcCost({ usage: usageSum, model: MODEL });
  onProgress(`✓ 재조판 완료 (${Math.round(buffer.length / 1024)}KB)`);
  return { buffer, cost, model: MODEL, figures: figureCount };
}

module.exports = {
  retypesetPdf,
  parseLatexOutput,
  parseFiguresJson,
  cropFigures,
  injectFigures,
  DEFAULT_MODEL,
};
