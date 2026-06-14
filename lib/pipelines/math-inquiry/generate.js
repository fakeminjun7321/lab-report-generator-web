// 수학Ⅲ 급수 탐구보고서 (수학 수행평가) — 콘텐츠 생성
//
// 입력: 주제(topic) + 사용자 메모(선택) + 내 글 스타일(선택). 필기노트·참고자료 업로드는 받지 않는다 —
//       수학 내용은 모델이 정확한 수학 지식으로 직접 구성하고, 선행연구·참고문헌은 web_search 로 실존 확인한다.
// 출력: prompt.md 스키마를 따르는 JSON (inquiry_topic / inquiry_purpose / prior_research / process / results_reflection / references)
//
// chem-pre/generate.js 와 같은 골격(스트리밍 + heartbeat + web_search + lenient JSON).

const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const { calcCost, calcImageCost, formatCostLine } = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const styleRef = require("../../style-ref");
const { deepCleanMarkers } = require("../../marker-clean");
const { renderChart } = require("../chem-result/chart-gen");
const {
  FILES_BETA,
  uploadFileToAnthropic,
  deleteAnthropicFile,
} = require("../../anthropic-files");

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "32000", 10);
const ENABLE_THINKING = process.env.ENABLE_THINKING === "1";
const THINKING_EFFORT = process.env.THINKING_EFFORT || "medium";

const SKILL_PATH = path.join(__dirname, "prompt.md");

function loadSkill() {
  return fs.readFileSync(SKILL_PATH, "utf8");
}

const FORMAT_INSTRUCTIONS = {
  hwpx: `## 현재 출력 형식

**OUTPUT_FORMAT: hwpx**

- 별도 줄로 보여줄 식, 분수·적분·시그마·행렬식은 \`{ "equation": "..." }\` 블록에 넣고, 내용은 한컴 수식 스크립트로 작성하세요. HWPX 출력 시 진짜 한글 수식 객체로 변환됩니다.
- 본문 문자열 안의 복잡한 인라인 식도 필요하면 \`{{EQ:...}}\` 로 감쌀 수 있습니다.

**한컴 수식 스크립트 문법** (LaTeX 아님):
- 분수: \`{a} over {b}\`
- 제곱근: \`sqrt {1 - v^2 / c^2}\`
- 위/아래첨자: \`x^2\`, \`v_{x}\`, \`gamma\`
- 적분/시그마: \`int _{0} ^{t} f dt\`, \`sum _{i=1} ^{n} x_i\`
- 화살표: \`->\`
- \`{{MATH:...}}\`, \`{{FORMULA:...}}\`, \`[[수식]]\` 같은 표기는 금지입니다.`,
  docx: `## 현재 출력 형식

**OUTPUT_FORMAT: docx**

- 이중 중괄호 수식 마커(\`{{EQ:...}}\` 등)를 절대 쓰지 마세요.
- 인라인 텍스트 마커만 사용합니다: \`v_{x}\`, \`c^{2}\`, \`*v*\`, \`Δt\`, \`γ\`, \`→\`, \`×\`.
- 별도 줄 수식 블록 \`{ "equation": "..." }\` 의 내용도 위 인라인 마커로 작성하세요.`,
};

function applyHighlightPolicy(text, allowHighlights) {
  if (allowHighlights) return text;
  return String(text).replace(
    /- 핵심 강조: `\*\*\.\.\.\*\*`[^\n]*/g,
    "- 핵심 강조: 관리자 전용 기능이므로 `**...**` 마커를 쓰지 마세요. 강조가 필요하면 일반 문장으로 표현하세요.",
  );
}

const STYLE_EMULATION_SECTION = `## 문체 흉내 (사용자 글 스타일 반영)

사용자가 **자기 글 샘플**(또는 문체 메모)을 제공했습니다. 보고서를 그 사람의 글처럼 들리게 쓰세요.

- 흉내 낼 것: 어조·말투(예: 격식체/구어체), 문장 리듬과 길이, 설명 방식(직관 우선·비유 사용·"대부분은 여기서 헷갈린다"식 오개념 짚기 등), 소제목 표기 습관(예: 영어 헤더), 수식 제시 방식(단계별 \`=>\` 유도 등), 강조 방식.
- **절대 가져오지 말 것**: 샘플의 \*\*주제·내용·수식·예시·문장 자체\*\*. 샘플이 다른 주제(예: 전자기학)여도 그 내용을 이 보고서에 끌어오면 안 됩니다. **오직 "어떻게 쓰는가(문체)"만** 흉내 내고, "무엇을 쓰는가(내용)"는 이 보고서의 주제에서만 가져옵니다.
- 보고서 양식(Ⅰ~Ⅴ 구조와 절 구성)과 JSON 스키마는 그대로 유지하면서, 각 절 본문의 **문장 스타일**만 사용자 글처럼 맞춥니다.
- 단, 제출용 보고서로서 최소한의 단정함은 유지하세요(과한 비속어·의미 없는 채팅 약어는 절제).`;

function buildSystemPrompt(
  outputFormat = "docx",
  { allowHighlights = true, hasStyle = false } = {},
) {
  const skill = applyHighlightPolicy(loadSkill(), allowHighlights);
  const formatSection =
    FORMAT_INSTRUCTIONS[outputFormat] || FORMAT_INSTRUCTIONS.docx;
  const styleSection = hasStyle ? `\n${STYLE_EMULATION_SECTION}\n` : "";
  return `당신은 (영재학교)과학고등학교 학생을 위한 "수학Ⅲ 급수 탐구보고서"(수행평가) 초안 작성 도우미입니다.

아래 스킬 명세의 모든 규칙(절 구성과 채점 기준, 수학적 정확성, 환각 금지, 1인칭 탐구 문체, JSON 스키마)을 정확히 따르세요.

=========== SKILL SPEC START ===========
${skill}
=========== SKILL SPEC END ===========

${formatSection}
${styleSection}
## 다시 강조

- 출력은 단 하나의 \`\`\`json ... \`\`\` 코드 블록입니다. JSON 외 텍스트는 무시됩니다.
- 업로드 자료 없이 주제만 주어집니다. 모든 수학 내용은 정확한 수학 지식으로 직접 구성하고, 선행연구·참고문헌은 web_search 로 실존 확인한 자료만 쓰세요. 가짜 수치·가짜 인용 금지. 표·차트의 숫자는 직접 계산해 검산한 값만.
- 채점 기준 최고 밴드를 모든 절에서 의식하세요: ① 창의적 시도·독창적 접근(스스로 만든 예시, 직접 계산한 비교, 타 분야 연결 — 기존 예시 단순 정리는 감점 밴드), ② 논리적·체계적 서술 + 표·그래프·수식의 효과적 활용(표 1+·그래프 1+ 필수, 각 자료 뒤 해석 단락), ③ 절마다 핵심이 분명한 전달.
- Ⅳ(탐구 과정 및 탐구 내용)가 가장 길어야 합니다(전체의 40~50%). **분량 목표 A4 4~8쪽**, 수식 유도는 풀버전으로. 짧은 요약본은 실패입니다.${hasStyle ? "\n- 위 '문체 흉내' 지침에 따라 사용자 글 스타일로 쓰되, 샘플의 내용은 가져오지 마세요." : ""}`;
}

function buildUserNotesBlock(userNotes) {
  const notes = String(userNotes || "").trim();
  if (!notes) return "";
  return `=== 사용자 참고 메모 / 내 의견 ===
${notes}
=== 메모 끝 ===

위 메모는 학생이 강조하고 싶은 맥락·관점(탐구 동기, 다루길 원하는 방향, 직접 해 본 것 등)입니다. 보고서에 자연스럽게 녹이되 보조로만 반영하세요. 메모에 없는 구체적 사건·인용은 새로 만들지 마세요.`;
}

/**
 * @param {Object} args
 * @param {string} args.topic               급수 탐구 주제(필수)
 * @param {string} args.userNotes           참고 메모(선택)
 * @param {Array}  args.styleRefs           내 글 스타일 참고 파일 [{buffer,name,mimetype}] — 문체만 흉내
 * @param {string} args.styleNote           원하는 문체 한 줄 메모(선택)
 * @param {Function} args.onProgress        (msg)=>void
 * @returns {Promise<Object>}               파싱된 보고서 JSON
 */
async function generateReportContent({
  topic = "",
  userNotes = "",
  styleRefs = [],
  styleNote = "",
  date,
  onProgress = () => {},
  signal,
  model = null,
  outputFormat = "docx",
  allowHighlights = true,
}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }

  const MODEL = model || DEFAULT_MODEL;
  const OUTPUT_FORMAT = outputFormat === "hwpx" ? "hwpx" : "docx";
  const topicText = String(topic || "").trim();
  if (!topicText) throw new Error("탐구 주제(topic)가 비어 있습니다.");
  const styleNoteText = String(styleNote || "").trim().slice(0, 1500);
  const hasStyle =
    (Array.isArray(styleRefs) && styleRefs.length > 0) || !!styleNoteText;

  onProgress(`🤖 모델: ${MODEL} | 출력: ${OUTPUT_FORMAT}${hasStyle ? " | 내 문체 반영" : ""}`);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 50 * 60 * 1000 /* Fable 등 장시간 스트림 — 작업 타임아웃(45분)보다 길게 */ });
  const system = buildSystemPrompt(OUTPUT_FORMAT, { allowHighlights, hasStyle });

  const content = [];
  const attachmentSummary = [];

  // 큰 PDF 는 인라인 base64(요청당 32MB 한도)로 못 보내므로 Files API 로 업로드해
  // file_id 로 참조한다. 작은 PDF 는 그대로 인라인. usedFileApi 면 메시지에 files
  // beta 헤더를 붙이고, 끝나면 업로드 파일을 정리한다. (phys-inquiry/generate.js 와
  // 동일한 우회 방식 — math-inquiry 는 Claude/Fable 전용이라 분기가 더 단순하다.)
  //
  // math-inquiry 는 자체 PDF 입력 필드는 없지만, "내 글 스타일 참고"(styleRefs)로
  // 올린 PDF 가 styleRef.buildStyleBlocks 에서 인라인 base64 로 들어온다. 큰 스타일
  // PDF 가 32MB 한도를 넘기지 않도록, 그 블록들을 Files API 참조로 오프로드한다.
  const FILES_API_RAW_THRESHOLD = 4.5 * 1024 * 1024; // ≥4.5MB raw PDF → Files API
  const INLINE_B64_BUDGET = 18 * 1024 * 1024; // 누적 인라인 base64 상한(32MB 요청 한도 여유)
  let inlineB64Used = 0;
  let usedFileApi = false;
  const uploadedFileIds = [];

  async function pushPdfBlock(f, { cacheControl = false } = {}) {
    const b64Len = Math.ceil(f.buffer.length / 3) * 4;
    const tooBigInline =
      f.buffer.length >= FILES_API_RAW_THRESHOLD ||
      inlineB64Used + b64Len > INLINE_B64_BUDGET;
    if (tooBigInline) {
      try {
        const fileId = await uploadFileToAnthropic(f.buffer, f.name, { signal });
        content.push({
          type: "document",
          source: { type: "file", file_id: fileId },
        });
        uploadedFileIds.push(fileId);
        usedFileApi = true;
        onProgress(
          `📤 큰 PDF 파일 업로드(Files API): ${f.name} (${Math.round((f.buffer.length / 1048576) * 10) / 10}MB)`,
        );
        return;
      } catch (e) {
        onProgress(`⚠ Files API 업로드 실패 → 인라인 전송 시도: ${e.message}`);
        // 인라인으로 폴백(요청이 32MB 를 넘으면 Anthropic 이 413 으로 막을 수 있음)
      }
    }
    const block = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: f.buffer.toString("base64"),
      },
    };
    if (cacheControl) block.cache_control = { type: "ephemeral" };
    content.push(block);
    inlineB64Used += b64Len;
  }

  // styleRef.buildStyleBlocks 가 만든 블록 배열에서, 큰 base64 PDF document 블록을
  // 찾아 Files API 참조(file_id)로 바꿔 큰 스타일 PDF 의 인라인 한도 초과를 막는다.
  // 공유 모듈(style-ref.js)을 건드리지 않고 결과 블록만 후처리한다. 작은 PDF·
  // 텍스트·이미지 블록은 그대로 둔다.
  async function offloadLargePdfBlocks(blocks) {
    const out = [];
    for (const block of blocks) {
      const src = block && block.type === "document" ? block.source : null;
      const isInlinePdf =
        src &&
        src.type === "base64" &&
        src.media_type === "application/pdf" &&
        typeof src.data === "string";
      if (!isInlinePdf) {
        // PDF 가 아닌 블록(텍스트/이미지) 은 누적 인라인 예산에 큰 영향이 없으므로 통과.
        out.push(block);
        continue;
      }
      const b64Len = src.data.length;
      const rawLen = Math.floor((b64Len * 3) / 4); // 대략적 원본 바이트 수
      const tooBigInline =
        rawLen >= FILES_API_RAW_THRESHOLD ||
        inlineB64Used + b64Len > INLINE_B64_BUDGET;
      if (tooBigInline) {
        try {
          const buf = Buffer.from(src.data, "base64");
          const fileId = await uploadFileToAnthropic(buf, "style-ref.pdf", {
            signal,
          });
          out.push({
            type: "document",
            source: { type: "file", file_id: fileId },
          });
          uploadedFileIds.push(fileId);
          usedFileApi = true;
          onProgress(
            `📤 큰 스타일 PDF 업로드(Files API): ${Math.round((rawLen / 1048576) * 10) / 10}MB`,
          );
          continue;
        } catch (e) {
          onProgress(`⚠ 스타일 PDF Files API 업로드 실패 → 인라인 시도: ${e.message}`);
          // 인라인으로 폴백
        }
      }
      inlineB64Used += b64Len;
      out.push(block);
    }
    return out;
  }

  // 1) 주제 (최우선 맥락)
  content.push({
    type: "text",
    text: `=== 학생이 선택한 급수 탐구 주제 ===
${topicText}
=== 주제 끝 ===

이 주제를 보고서의 중심으로 삼으세요.`,
  });

  // 2) 사용자 메모
  const notesBlock = buildUserNotesBlock(userNotes);
  if (notesBlock) {
    content.push({ type: "text", text: notesBlock });
    attachmentSummary.push("사용자 메모");
  }

  // 3) 내 글 스타일 참고 (문체만 흉내, 내용은 절대 가져오지 않음).
  //    공통 lib/style-ref.js 의 buildStyleBlocks 로 PDF/이미지/텍스트/.hwpx 를
  //    4개 보고서와 동일하게 처리한다(.hwpx 본문 텍스트 추출 포함).
  if (hasStyle) {
    const styleBlocks = await styleRef.buildStyleBlocks({
      styleRefs,
      styleNote: styleNoteText,
    });
    // 큰 스타일 PDF 는 Files API 로 오프로드(32MB 인라인 한도 우회).
    content.push(...(await offloadLargePdfBlocks(styleBlocks)));
    attachmentSummary.push("내 문체 참고");
  }

  // 4) 최종 지시
  content.push({
    type: "text",
    text: `위 주제${notesBlock ? "와 메모" : ""}를 바탕으로 "수학Ⅲ 급수 탐구보고서" 콘텐츠를 JSON으로 생성하세요.

보고서 날짜: ${date || "(미지정)"}

스킬 명세의 JSON 스키마와 수식 마커 규칙을 정확히 따르세요. 선행연구·참고문헌의 실존 확인에는 web_search 도구를 쓰세요.${hasStyle ? "\n문장 스타일은 위 '내 글 스타일 참고'의 문체를 흉내 내되, 그 샘플의 내용은 가져오지 마세요." : ""}

⚠️ 채점 기준 만점(40+40+20)이 목표입니다 — 창의적 시도(직접 계산한 비교·스스로 만든 예시·타 분야 연결), Ⅳ의 표 1개 이상 + 그래프 1개 이상 + 풀버전 수식 유도, 분량 A4 4~8쪽을 지키세요.
최종 출력은 단 하나의 \`\`\`json ... \`\`\` 코드 블록입니다.`,
  });

  const userMessage = { role: "user", content };

  onProgress(
    `📎 입력: 주제${attachmentSummary.length ? " + " + attachmentSummary.join(", ") : "만"} — Claude에게 전송`,
  );

  // ── Stream + heartbeat ────────────────────────────────────────────────────
  const startedAt = Date.now();
  let charCount = 0;
  let lastReportedChars = 0;
  let lastEventAt = Date.now();
  let webSearchCount = 0;
  let textBlocksStarted = 0;
  let firstTokenSeen = false;
  const elapsed = () => Math.floor((Date.now() - startedAt) / 1000);

  const heartbeat = setInterval(() => {
    const sinceLast = (Date.now() - lastEventAt) / 1000;
    if (sinceLast >= 12) {
      const note = !firstTokenSeen
        ? `Claude가 탐구 내용 구상 중... (${elapsed()}초 경과)`
        : `보고서 작성 중... (${charCount}자, ${elapsed()}초 경과)`;
      onProgress("⏳ " + note);
      lastEventAt = Date.now();
    }
  }, 5000);

  let finalText;
  let cost = null;
  try {
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        ...(ENABLE_THINKING
          ? {
              thinking: { type: "adaptive" },
              output_config: { effort: THINKING_EFFORT },
            }
          : {}),
        system: [
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 3 },
        ],
        messages: [userMessage],
      },
      (() => {
        // Files API 로 업로드한 PDF 를 참조하면 files beta 헤더가 필요하다.
        const o = {};
        if (signal) o.signal = signal;
        if (usedFileApi) o.headers = { "anthropic-beta": FILES_BETA };
        return Object.keys(o).length ? o : undefined;
      })(),
    );

    stream.on("streamEvent", (event) => {
      lastEventAt = Date.now();
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block?.type === "text") {
          textBlocksStarted++;
          if (textBlocksStarted === 1) {
            onProgress(`✍️ 보고서 작성 시작 (${elapsed()}초)`);
            firstTokenSeen = true;
          }
        } else if (
          block?.type === "server_tool_use" &&
          block?.name === "web_search"
        ) {
          webSearchCount++;
          onProgress(`🔍 선행연구 웹 검색 중... (${webSearchCount}번째)`);
        } else if (block?.type === "web_search_tool_result") {
          onProgress(`✓ 검색 결과 수신`);
        } else if (block?.type === "thinking") {
          if (!firstTokenSeen) onProgress(`🤔 추론 중... (${elapsed()}초)`);
        }
      }
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        event.delta.text
      ) {
        charCount += event.delta.text.length;
        if (charCount - lastReportedChars >= 1500) {
          onProgress(`보고서 작성 중... (${charCount}자, ${elapsed()}초)`);
          lastReportedChars = charCount;
        }
      }
      if (event.type === "message_delta" && event.delta?.stop_reason) {
        if (event.delta.stop_reason === "max_tokens") {
          onProgress("⚠ 응답 토큰 한도 도달");
        }
      }
    });

    const finalMessage = await stream.finalMessage();
    if (finalMessage.stop_reason === "max_tokens") {
      throw new Error("응답이 너무 길어 잘렸습니다. MAX_TOKENS를 늘려야 합니다.");
    }
    finalText = finalMessage.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    cost = calcCost({ usage: finalMessage.usage, webSearchCount, model: MODEL });
  } finally {
    clearInterval(heartbeat);
    // 업로드한 PDF 정리(베스트에포트). 스트림이 끝났으니 더 이상 필요 없다.
    if (uploadedFileIds.length) {
      await Promise.all(uploadedFileIds.map((id) => deleteAnthropicFile(id)));
    }
  }

  onProgress(`✓ Claude 응답 완료 (총 ${charCount}자, ${elapsed()}초) — JSON 파싱 중`);
  onProgress(formatCostLine(cost));

  const json = extractJson(finalText);
  if (!json) {
    throw new Error(
      "JSON 코드 블록을 찾을 수 없습니다. 응답 앞부분: " + finalText.slice(0, 300),
    );
  }
  let parsed;
  try {
    parsed = parseJsonLenient(json);
  } catch (e) {
    throw new Error("JSON 파싱 실패: " + e.message);
  }

  parsed = require("../../output-sanitize").sanitize(parsed, {
    preserveEquationPlaceholders: OUTPUT_FORMAT === "hwpx",
    allowHighlights,
  });

  // 모델이 종종 ① 복잡한 수식 구절을 *...*로 감싸 별표가 raw로 노출되고
  // ② p_i 같은 비중괄호 첨자를 써 변환이 안 된다 — 둘 다 결정적으로 정리.
  const markerFixes = { count: 0 };
  deepCleanMarkers(parsed, markerFixes);
  if (markerFixes.count) onProgress(`🧹 표기 정리: 별표/첨자 ${markerFixes.count}곳`);

  if (!parsed.title) parsed.title = topicText || "급수 탐구보고서";
  if (date) parsed.date = date;

  const sectionCount = [
    parsed.inquiry_topic,
    parsed.inquiry_purpose,
    parsed.prior_research,
    parsed.process,
    parsed.results_reflection,
  ].filter(Boolean).length;
  onProgress(`📋 구조: Ⅰ~Ⅴ 중 ${sectionCount}개 절, 참고문헌 ${(parsed.references || []).length}개`);

  // 데이터 없는 빈 차트 블록은 본문에서 통째로 제거 — 축만 있는 빈 그래프 PNG가
  // 보고서에 들어가는 것을 방지(chem-result와 동일 정책, math 스키마 기준).
  const chartHasData = (ch) => {
    const sets = Array.isArray(ch?.datasets) ? ch.datasets : [];
    return sets.some((s) => {
      const data = Array.isArray(s?.data) ? s.data : [];
      return data.some((v) => {
        if (v == null || v === "") return false;
        if (typeof v === "object")
          return Number.isFinite(Number(v.y ?? v[1])) || Number.isFinite(Number(v.x ?? v[0]));
        return Number.isFinite(Number(v));
      });
    });
  };
  let droppedEmptyCharts = 0;
  (function pruneEmptyCharts(node) {
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const item = node[i];
        if (
          item && typeof item === "object" && !Array.isArray(item) &&
          item.chart && typeof item.chart === "object" && !chartHasData(item.chart)
        ) {
          node.splice(i, 1);
          droppedEmptyCharts++;
        } else {
          pruneEmptyCharts(item);
        }
      }
      return;
    }
    if (node && typeof node === "object") Object.values(node).forEach(pruneEmptyCharts);
  })(parsed);
  if (droppedEmptyCharts)
    onProgress(`⚠️ 데이터 없는 빈 차트 ${droppedEmptyCharts}개 제외`);

  // 차트 블록 → PNG 렌더 (표·그래프 자료 활용 평가요소)
  const chartBlocks = [];
  (function collect(node) {
    if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === "object") {
      if (node.chart && typeof node.chart === "object") chartBlocks.push(node.chart);
      else Object.values(node).forEach(collect);
    }
  })(parsed);
  if (chartBlocks.length) {
    let rendered = 0;
    for (const chart of chartBlocks) {
      try {
        const buf = await renderChart(chart);
        if (buf) {
          Object.defineProperty(chart, "pngBuffer", { value: buf, enumerable: false });
          rendered++;
        }
      } catch (e) {
        onProgress(`⚠ 차트 렌더 실패(생략): ${e.message}`);
      }
    }
    if (rendered) onProgress(`📈 그래프 ${rendered}개 렌더 완료`);
  }

  const imageCost = calcImageCost({ searchCount: 0, generationCount: 0 });
  Object.defineProperty(parsed, "__cost", {
    value: cost,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(parsed, "__imageCost", {
    value: imageCost,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(parsed, "__style", {
    value: "default",
    enumerable: false,
    writable: false,
  });

  return parsed;
}

function extractJson(text) {
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const anyFence = text.match(/```\s*([\s\S]*?)```/);
  if (anyFence) return anyFence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return null;
}

module.exports = { generateReportContent };
