// translate_pdf.py 를 spawn 하는 Node 래퍼.
// hwpx-gen.js 와 동일한 Python 탐지 규칙(.venv 우선, PYTHON_BIN 존중)을 따른다.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "translate_pdf.py");

function detectPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venvPython = path.resolve(process.cwd(), ".venv/bin/python3");
  if (fs.existsSync(venvPython)) return venvPython;
  const venvPython2 = path.resolve(__dirname, "../../../.venv/bin/python3");
  if (fs.existsSync(venvPython2)) return venvPython2;
  return "python3";
}

const PYTHON = detectPython();

function runPy(args, { stdin = null, signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [PY_SCRIPT, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out = [];
    const err = [];
    proc.stdout.on("data", (c) => out.push(c));
    proc.stderr.on("data", (c) => err.push(c));

    proc.on("error", (e) =>
      reject(
        new Error(
          `translate_pdf.py 실행 실패: ${e.message} (PYTHON_BIN=${PYTHON})`,
        ),
      ),
    );

    proc.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(err).toString("utf8").trim();
        return reject(
          new Error(
            `translate_pdf.py ${args[0]} 실패 (code ${code})${stderr ? ": " + stderr.slice(0, 600) : ""}`,
          ),
        );
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });

    if (signal) {
      if (signal.aborted) proc.kill("SIGKILL");
      else
        signal.addEventListener("abort", () => proc.kill("SIGKILL"), {
          once: true,
        });
    }

    try {
      if (stdin != null) proc.stdin.write(stdin);
    } catch {
      /* EPIPE if process already gone — close handler reports the real error */
    }
    proc.stdin.end();
  });
}

// PDF 에서 번역 대상 문단을 추출한다.
// → { page_count, scanned, blocks: [{ id, page, text }] }
async function extractBlocks(pdfPath, opts = {}) {
  const out = await runPy(["extract", pdfPath], opts);
  return JSON.parse(out);
}

// 번역문(id→한국어)을 원본 레이아웃에 끼워넣어 outPath 에 저장한다.
// → { ok, replaced, shrunk }
async function renderTranslated(pdfPath, outPath, fontPath, translations, opts = {}) {
  const out = await runPy(["render", pdfPath, outPath, fontPath], {
    ...opts,
    stdin: JSON.stringify({ translations }),
  });
  return JSON.parse(out);
}

// 텍스트 레이어 유무만 빠르게 판정(스캔/이미지 PDF 라우팅용).
// → { page_count, text_chars, scanned }
async function analyzePdf(pdfPath, opts = {}) {
  const out = await runPy(["analyze", pdfPath], opts);
  return JSON.parse(out);
}

// 페이지를 가독 PNG 타일로 렌더링(세로로 긴 페이지는 잘라서) outDir 에 저장.
// → { page_count, rendered_pages, tiles, truncated, files: [absPath...] }
async function rasterizePages(pdfPath, outDir, opts = {}) {
  const targetWidth = parseInt(opts.targetWidth || 1400, 10);
  const maxPages = parseInt(opts.maxPages || 20, 10);
  const out = await runPy(
    ["rasterize", pdfPath, outDir, String(targetWidth), String(maxPages)],
    opts,
  );
  return JSON.parse(out);
}

// 텍스트 PDF 를 페이지 범위 sub-PDF 들로 분할(재조판 병렬화용).
// → { page_count, chunks: [{ path, start, end }] }
async function splitPdf(pdfPath, outDir, opts = {}) {
  const per = parseInt(opts.pagesPerChunk || 5, 10);
  const out = await runPy(["split", pdfPath, outDir, String(per)], opts);
  return JSON.parse(out);
}

module.exports = {
  extractBlocks,
  renderTranslated,
  analyzePdf,
  rasterizePages,
  splitPdf,
  PYTHON,
};
