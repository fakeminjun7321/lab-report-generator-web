// 보고서 생성용 제공자-인지 모델 호출 헬퍼.
//
// 보고서 파이프라인들은 Anthropic 형식 content 블록(text/document(base64 PDF)/image(base64))과
// 시스템 프롬프트로 Claude 를 스트리밍 호출한다. GPT(OpenAI) 모델일 때는 이 헬퍼가 그 블록을
// OpenAI chat/completions 형식(file/file_data, image_url, text)으로 변환해 호출하고, 결과를
// { text, usage } 로 돌려준다(usage 는 calcCost 가 그대로 쓰도록 Anthropic 형식).
//
// 시스템 프롬프트는 Claude/GPT 공용 prompt.md 를 그대로 쓴다(모델 무관).
// 웹검색(chem-pre 시약 물성): OpenAI chat/completions 엔 Anthropic web_search 가 없으므로
// GPT 경로에선 도구 없이 모델 지식으로 채운다. 필요시 추후 Responses API web_search 로 확장 가능.

const GPT_BASE = process.env.GPT_API_BASE || "https://api.openai.com/v1";

function isGptModel(m) {
  return /^gpt/i.test(String(m || ""));
}

function gptKey() {
  return process.env.GPT_API_KEY || process.env.OPENAI_API_KEY || "";
}
function gptConfigured() {
  return !!gptKey();
}

// Anthropic system(문자열 또는 [{type:'text',text,...}]) → OpenAI system 문자열.
function systemToText(system) {
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === "string" ? b : b && b.text ? b.text : ""))
      .join("\n");
  }
  return String(system || "");
}

// Anthropic content 블록 배열 → OpenAI chat content 파트 배열.
function toOpenAiContent(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (!b) continue;
    if (b.type === "text") {
      out.push({ type: "text", text: b.text || "" });
    } else if (b.type === "document" && b.source && b.source.type === "base64") {
      out.push({
        type: "file",
        file: {
          filename: b.source.filename || "document.pdf",
          file_data: `data:${b.source.media_type || "application/pdf"};base64,${b.source.data}`,
        },
      });
    } else if (b.type === "image" && b.source && b.source.type === "base64") {
      out.push({
        type: "image_url",
        image_url: {
          url: `data:${b.source.media_type || "image/png"};base64,${b.source.data}`,
        },
      });
    }
    // web_search 등 tool 블록·기타는 GPT 경로에서 무시.
  }
  return out;
}

// GPT 보고서 생성 호출. params 는 Anthropic 스타일(system, content, model, maxTokens).
// → { text, usage:{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens} }
async function callGptReport({
  model,
  system,
  content,
  maxTokens = 32000,
  jsonObject = true,
  signal,
  onProgress = () => {},
}) {
  const key = gptKey();
  if (!key) {
    throw new Error("GPT_API_KEY(OpenAI) 환경변수가 설정되지 않았습니다.");
  }
  const messages = [
    { role: "system", content: systemToText(system) },
    { role: "user", content: toOpenAiContent(content) },
  ];
  const body = {
    model,
    messages,
    max_completion_tokens: Math.min(maxTokens, 32000),
  };
  // 보고서는 단일 JSON 객체를 기대 → json_object 로 강제(파서 안정).
  if (jsonObject) body.response_format = { type: "json_object" };

  onProgress(`🤖 ${model} 에게 전송 — 보고서 생성 중...`);
  const resp = await fetch(`${GPT_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenAI ${resp.status}: ${raw.slice(0, 300)}`);
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error(
      `OpenAI 응답을 해석할 수 없습니다(${resp.status}, ${raw.length}바이트)${raw ? ": " + raw.slice(0, 160) : " — 빈 응답"}`,
    );
  }
  const choice = (j.choices && j.choices[0]) || {};
  const text = (choice.message && choice.message.content) || "";
  if (choice.finish_reason === "length") {
    throw new Error(
      "GPT 출력이 최대 길이에 도달해 잘렸습니다. 입력을 줄이거나 다시 시도하세요.",
    );
  }
  if (!text || !text.trim()) {
    throw new Error("GPT가 빈 응답을 반환했습니다.");
  }
  const u = j.usage || {};
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    text,
    usage: {
      input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached),
      output_tokens: u.completion_tokens || 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  };
}

module.exports = {
  isGptModel,
  gptConfigured,
  systemToText,
  toOpenAiContent,
  callGptReport,
};
