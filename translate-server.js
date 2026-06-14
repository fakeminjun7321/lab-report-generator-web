// 독립 PDF 통번역 사이트 서버 (같은 repo · 별도 Render 서비스).
//
// 메인 server.js 는 손대지 않는다(라이브 보고서 생성 보호). 번역 "엔진"은
// lib/pipelines/pdf-translate/* 를 그대로 공유하고(단일 소스), 여기서는 얇은
// 잡(job)/SSE/게이트/오케스트레이션만 둔다.
//
// 접근: 비밀번호/초대코드(TRANSLATE_ACCESS_CODES). 코드 미설정 + 비프로덕션이면
// 개방(로컬 점검용), 프로덕션에서 코드 미설정이면 차단.
//
// 실행: node translate-server.js  (Render: 별도 서비스 start command)

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ── 공유 엔진 (메인 사이트와 동일 코드) ──────────────────────────────────────
const { translatePdf } = require("./lib/pipelines/pdf-translate/translate");
const { retypesetPdf } = require("./lib/pipelines/pdf-translate/latex-gen");
const {
  analyzePdf,
  splitPdf,
  rasterizePages,
  extractFigures,
} = require("./lib/pipelines/pdf-translate/pdf-tool");
const {
  prepareImageForAnthropic,
  toAnthropicImageBlock,
} = require("./lib/anthropic-media");

const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.TRANSLATE_PORT || process.env.PORT || "4100", 10);
const IS_PROD = process.env.NODE_ENV === "production";
const PDF_TRANSLATE_TIMEOUT_MS = parseInt(
  process.env.PDF_TRANSLATE_TIMEOUT_MS || String(20 * 60 * 1000),
  10,
);
const ALLOWED_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
];
const DEFAULT_MODEL = "claude-opus-4-8";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// ── 비밀번호/초대코드 게이트 ─────────────────────────────────────────────────
const SECRET =
  process.env.TRANSLATE_SESSION_SECRET ||
  crypto.createHash("sha256").update("quilo-translate:" + (process.env.TRANSLATE_ACCESS_CODES || "dev")).digest("hex");
const CODES = String(
  process.env.TRANSLATE_ACCESS_CODES || process.env.TRANSLATE_ACCESS_CODE || "",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const tokenFor = (code) =>
  crypto.createHmac("sha256", SECRET).update("v1:" + code).digest("hex");
const VALID_TOKENS = new Set(CODES.map(tokenFor));
const OPEN_NO_GATE = CODES.length === 0 && !IS_PROD; // 로컬 개방, 프로덕션은 차단

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  if (OPEN_NO_GATE) return true;
  return VALID_TOKENS.has(parseCookies(req).tr);
}
function requireCode(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "코드 인증이 필요합니다." });
}

app.get("/api/me", (req, res) => {
  res.json({
    authed: isAuthed(req),
    gated: !OPEN_NO_GATE,
    configured: CODES.length > 0 || OPEN_NO_GATE,
  });
});
app.post("/api/login", (req, res) => {
  const code = String((req.body && req.body.code) || "").trim();
  if (OPEN_NO_GATE) return res.json({ ok: true });
  if (CODES.length === 0)
    return res.status(503).json({ error: "관리자가 접근 코드(TRANSLATE_ACCESS_CODES)를 설정해야 합니다." });
  if (!code || !CODES.includes(code))
    return res.status(401).json({ error: "코드가 올바르지 않습니다." });
  res.setHeader(
    "Set-Cookie",
    `tr=${tokenFor(code)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${IS_PROD ? "; Secure" : ""}`,
  );
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "tr=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

// ── 얇은 잡(job)/SSE 매니저 ──────────────────────────────────────────────────
const jobs = new Map();
function createJob() {
  const id = crypto.randomBytes(8).toString("hex");
  const job = { id, status: "running", progress: [], listeners: [], createdAt: Date.now(), result: null };
  jobs.set(id, job);
  return job;
}
function sendSse(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function pushProgress(job, msg) {
  let line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  if (line.length > 500) line = line.slice(0, 500) + "…(truncated)";
  job.progress.push(line);
  if (job.progress.length > 200) job.progress.splice(0, job.progress.length - 200);
  console.log(`[job ${job.id}] ${line}`);
  job.listeners.forEach((r) => sendSse(r, "progress", line));
}
setInterval(() => {
  const cut = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, j] of jobs) if (j.createdAt < cut) jobs.delete(id);
}, 60 * 60 * 1000).unref?.();

// ── 파일명 헬퍼 (server.js 와 동일 동작) ─────────────────────────────────────
function sanitizeForFilename(s) {
  return String(s || "").normalize("NFC").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 30);
}
function normalizeUploadFilename(value) {
  const original = String(value || "");
  if (!original) return "";
  try {
    const decoded = Buffer.from(original, "latin1").toString("utf8");
    const hasHangul = /[가-힣ㄱ-ㅎㅏ-ㅣᄀ-ᇿ]/;
    const looksMojibake = /[ÃÂ]|[-]/.test(original);
    if ((hasHangul.test(decoded) && !hasHangul.test(original)) || looksMojibake) return decoded;
  } catch {
    /* keep */
  }
  return original;
}
function buildTranslatedFilename(originalName, suffix = "_KO") {
  const base = sanitizeForFilename(String(originalName || "document.pdf").replace(/\.pdf$/i, "")) || "document";
  return `${base}${suffix}.pdf`;
}

// ── 오케스트레이션 헬퍼 (server.js 와 동일 로직, 공유 엔진 호출) ─────────────
async function splitPdfToBuffers(pdfBuffer, { signal, onProgress }) {
  const per = parseInt(process.env.PDF_RETYPESET_CHUNK_PAGES || "5", 10);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfsplit-"));
  const pdfPath = path.join(tmpDir, "in.pdf");
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    const meta = await splitPdf(pdfPath, tmpDir, { pagesPerChunk: per, signal });
    if (!meta.chunks || meta.chunks.length <= 1) return null;
    return meta.chunks.map((c) => ({ buffer: fs.readFileSync(c.path), start: c.start, end: c.end }));
  } catch (e) {
    onProgress(`⚠ 구간 분할 건너뜀(단일 처리): ${e.message}`);
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
async function extractFiguresForRetypeset(pdfBuffer, { signal, onProgress }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdffig-"));
  const pdfPath = path.join(tmpDir, "in.pdf");
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    const meta = await extractFigures(pdfPath, tmpDir, { signal });
    return (meta.figures || [])
      .map((f) => {
        try { return { n: f.n, page: f.page, caption: f.caption || "", buffer: fs.readFileSync(f.file) }; }
        catch { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    onProgress(`⚠ 그림 추출 건너뜀(텍스트만 재조판): ${e.message}`);
    return [];
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
async function prepareScannedRouting(pdfBuffer, { signal, onProgress }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdftr-"));
  const pdfPath = path.join(tmpDir, "in.pdf");
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    let scanned = false, mathDensity = 0, twoColumn = false;
    try {
      const a = await analyzePdf(pdfPath, { signal });
      scanned = !!a.scanned;
      mathDensity = Number(a.math_density) || 0;
      twoColumn = !!a.two_column;
    } catch (e) {
      onProgress(`⚠ 텍스트 레이어 분석을 건너뜁니다: ${e.message}`);
      return { scanned: false, imageBlocks: null, mathDensity: 0, twoColumn: false };
    }
    if (!scanned) return { scanned: false, imageBlocks: null, mathDensity, twoColumn };
    onProgress("🖼️ 텍스트 레이어가 없는 스캔/이미지 PDF 감지 → 고해상도 OCR 재조판으로 전환");
    const maxPages = parseInt(process.env.PDF_OCR_MAX_PAGES || "30", 10);
    const meta = await rasterizePages(pdfPath, tmpDir, { maxPages, signal });
    if (!meta.files || !meta.files.length) throw new Error("페이지 이미지를 생성하지 못했습니다.");
    onProgress(`🧩 페이지를 ${meta.tiles}개 이미지 조각으로 분할(읽기 좋게)`);
    const tileBuffers = meta.files.map((f) => fs.readFileSync(f));
    const prepared = await Promise.all(
      tileBuffers.map((buf, i) =>
        prepareImageForAnthropic(
          { buffer: buf, name: path.basename(meta.files[i]), mimetype: "image/png" },
          { forceCompress: true },
        ).catch(() => null),
      ),
    );
    const blocks = [], keptTiles = [];
    prepared.forEach((p, i) => {
      if (p && p.ok) { blocks.push(toAnthropicImageBlock(p)); keptTiles.push(tileBuffers[i]); }
    });
    if (!blocks.length) throw new Error("이미지를 Claude 입력 형식으로 준비하지 못했습니다.");
    return {
      scanned: true, imageBlocks: blocks, tileBuffers: keptTiles,
      truncated: !!meta.truncated, tiles: meta.tiles, pageCount: meta.page_count,
      mathDensity, twoColumn,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// 단순 시간 예측(비용 표시 없음 — 독립 사이트는 크레딧 없음).
function estimateTime(meta, mode, modelId) {
  const pages = Math.max(1, Number(meta.page_count) || 1);
  const chars = Math.max(0, Number(meta.text_chars) || 0);
  const scanned = !!meta.scanned;
  const density = Number(meta.math_density) || 0;
  const TH = Number(process.env.PDF_AUTO_MATH_THRESHOLD || 12);
  const needsRetypeset = scanned || density >= TH;
  const resolvedMode = mode === "retypeset" ? "retypeset" : mode === "inplace" ? (scanned ? "retypeset" : "inplace") : needsRetypeset ? "retypeset" : "inplace";
  const isOpus = /opus/i.test(modelId || "");
  const ocrMax = parseInt(process.env.PDF_OCR_MAX_PAGES || "30", 10);
  const maxPages = parseInt(process.env.PDF_TRANSLATE_MAX_PAGES || "80", 10);
  let seconds = 0;
  if (scanned) {
    const procPages = Math.min(pages, ocrMax);
    const tiles = Math.min(100, Math.ceil(procPages * 1.3));
    seconds = 1.5 * procPages + tiles * (isOpus ? 4.0 : 2.6) + 18;
  } else if (resolvedMode === "retypeset") {
    const waves = Math.ceil(Math.ceil(pages / 5) / 6);
    seconds = 0.3 * pages + waves * (isOpus ? 45 : 28) + 18;
  } else {
    const waves = Math.ceil(Math.max(1, Math.ceil(chars / 3500)) / 10);
    seconds = 1.2 * pages + (waves + 1) * (isOpus ? 13 : 8);
  }
  return {
    mode: resolvedMode, scanned, pages, chars,
    truncated: scanned && pages > ocrMax,
    tooManyPages: !scanned && pages > maxPages, maxPages,
    seconds: { lo: Math.round(seconds * 0.8), hi: Math.round(seconds * 1.55) },
  };
}

async function runPdfTranslation(job, { pdfBuffer, originalName, model, mode }) {
  const t0 = Date.now();
  const timeoutMin = Math.round(PDF_TRANSLATE_TIMEOUT_MS / 60000);
  pushProgress(job, `🚀 PDF 통번역 시작 (timeout: ${timeoutMin}분)`);
  const ac = new AbortController();
  job.abortController = ac;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    pushProgress(job, `⏰ ${timeoutMin}분 초과 — 강제 종료 중...`);
    ac.abort();
  }, PDF_TRANSLATE_TIMEOUT_MS);
  try {
    pushProgress(job, `📥 PDF 수신 (${Math.round(pdfBuffer.length / 1024)}KB)`);
    const onProgress = (msg) => pushProgress(job, msg);
    const routing = await prepareScannedRouting(pdfBuffer, { signal: ac.signal, onProgress });
    const TH = Number(process.env.PDF_AUTO_MATH_THRESHOLD || 12);
    const isAuto = mode !== "inplace" && mode !== "retypeset";
    const needsRetypeset = routing.scanned || (routing.mathDensity || 0) >= TH;
    let resolvedMode;
    if (mode === "retypeset") resolvedMode = "retypeset";
    else if (mode === "inplace") resolvedMode = routing.scanned ? "retypeset" : "inplace";
    else resolvedMode = needsRetypeset ? "retypeset" : "inplace";
    if (mode === "inplace" && routing.scanned)
      pushProgress(job, "⚠ 스캔본/이미지 PDF는 '빠른 번역'이 불가능 → 'OCR 재조판'으로 전환합니다.");
    else if (isAuto)
      pushProgress(job, `🔎 자동 변환방식 → ${resolvedMode === "retypeset" ? "재조판(수식·정밀)" : "빠른 번역(레이아웃 유지)"}` + (routing.scanned ? " · 스캔본 감지" : ` · 수식밀도 ${routing.mathDensity ?? 0}`));

    let effectiveMode = resolvedMode;
    let result;
    if (routing.scanned && routing.imageBlocks) {
      if (routing.truncated) pushProgress(job, `⚠ 분량이 많아 앞부분 위주로 처리합니다(이미지 ${routing.tiles}조각).`);
      result = await retypesetPdf({ pdfBuffer, imageBlocks: routing.imageBlocks, tiles: routing.tileBuffers, model, signal: ac.signal, onProgress });
      effectiveMode = "retypeset";
      if (result.figures) pushProgress(job, `🖼️ 원본 그림 ${result.figures}개를 본문에 복원했습니다.`);
    } else if (resolvedMode === "retypeset") {
      try {
        const figures = await extractFiguresForRetypeset(pdfBuffer, { signal: ac.signal, onProgress });
        if (figures.length) pushProgress(job, `🖼️ 본문 그림 ${figures.length}개 추출 — 재조판본에 복원합니다.`);
        if (routing.twoColumn) pushProgress(job, "📐 2단 레이아웃 감지 — 2단으로 조판합니다.");
        const pdfChunks = await splitPdfToBuffers(pdfBuffer, { signal: ac.signal, onProgress });
        result = await retypesetPdf({ pdfBuffer, pdfChunks, figures, twoColumn: routing.twoColumn, model, signal: ac.signal, onProgress });
        if (result.figures) pushProgress(job, `🖼️ 원본 그림 ${result.figures}개를 재조판본에 복원했습니다.`);
      } catch (e) {
        if (ac.signal.aborted || timedOut) throw e;
        pushProgress(job, `⚠ 재조판 실패 → '빠른 번역(레이아웃 유지)'으로 대체합니다: ${String(e.message || e).slice(0, 160)}`);
        effectiveMode = "inplace";
        result = await translatePdf({ pdfBuffer, model, signal: ac.signal, onProgress });
      }
    } else {
      result = await translatePdf({ pdfBuffer, model, signal: ac.signal, onProgress });
    }

    job.result = result.buffer;
    job.mimeType = "application/pdf";
    job.filename = buildTranslatedFilename(originalName, effectiveMode === "retypeset" ? "_재조판" : "_KO");
    job.status = "done";
    const totalSec = Math.floor((Date.now() - t0) / 1000);
    const outKB = Math.round(result.buffer.length / 1024);
    pushProgress(
      job,
      effectiveMode === "retypeset"
        ? `🎉 재조판 완료! ${outKB}KB, 총 ${totalSec}초. 다운로드 가능합니다.`
        : `🎉 완료! ${result.pageCount}쪽 / 문단 ${result.blockCount}개 → ${outKB}KB, 총 ${totalSec}초. 다운로드 가능합니다.`,
    );
  } catch (e) {
    if (timedOut) throw new Error(`${timeoutMin}분 timeout 으로 강제 종료되었습니다.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  job.listeners.forEach((r) => { sendSse(r, "done", { filename: job.filename }); r.end(); });
  job.listeners = [];
}

// ── 라우트 ───────────────────────────────────────────────────────────────────
app.post("/api/translate-pdf/estimate", requireCode, upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "PDF 파일이 필요합니다." });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfest-"));
  const pdfPath = path.join(tmpDir, "in.pdf");
  try {
    fs.writeFileSync(pdfPath, req.file.buffer);
    const meta = await analyzePdf(pdfPath, {});
    res.json({ ...estimateTime(meta, String(req.body.mode || "auto"), String(req.body.model || DEFAULT_MODEL)), meta });
  } catch (e) {
    res.status(500).json({ error: e.message || "예측 실패" });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

app.post("/api/translate-pdf", requireCode, upload.single("pdf"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "PDF 파일을 업로드하세요." });
  file.originalname = normalizeUploadFilename(file.originalname);
  if (file.mimetype !== "application/pdf" && !/\.pdf$/i.test(file.originalname || ""))
    return res.status(400).json({ error: "PDF 파일만 업로드 가능합니다." });
  const requested = String(req.body.model || "").trim();
  const model = ALLOWED_MODELS.includes(requested) ? requested : DEFAULT_MODEL;
  const reqMode = String(req.body.mode || "").trim();
  const mode = ["inplace", "retypeset", "auto"].includes(reqMode) ? reqMode : "auto";
  const job = createJob();
  res.json({ jobId: job.id });
  runPdfTranslation(job, { pdfBuffer: file.buffer, originalName: file.originalname || "document.pdf", model, mode }).catch((err) => {
    job.status = "error";
    job.error = err.message || String(err);
    pushProgress(job, `❌ 오류: ${job.error}`);
    job.listeners.forEach((r) => { sendSse(r, "error", job.error); r.end(); });
    job.listeners = [];
  });
});

app.get("/api/jobs/:id/stream", requireCode, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  job.progress.forEach((p) => sendSse(res, "progress", p));
  if (job.status === "done") { sendSse(res, "done", { filename: job.filename }); return res.end(); }
  if (job.status === "error") { sendSse(res, "error", job.error); return res.end(); }
  job.listeners.push(res);
  req.on("close", () => { job.listeners = job.listeners.filter((r) => r !== res); });
});

app.get("/api/jobs/:id/download", requireCode, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done" || !job.result)
    return res.status(404).json({ error: "결과를 찾을 수 없습니다(만료되었거나 미완료)." });
  const fn = job.filename || "translated.pdf";
  res.setHeader("Content-Type", job.mimeType || "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="translated.pdf"; filename*=UTF-8''${encodeURIComponent(fn)}`,
  );
  res.setHeader("Content-Length", job.result.length);
  res.send(job.result);
});

// ── 정적 (UI) ────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "translate-app.html")));
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[translate] PDF 통번역 사이트 :${PORT} (gate=${OPEN_NO_GATE ? "OPEN(dev)" : CODES.length + " codes"})`);
  if (IS_PROD && CODES.length === 0)
    console.warn("[translate] ⚠ TRANSLATE_ACCESS_CODES 미설정 — 프로덕션에서 모든 접근이 차단됩니다.");
});
