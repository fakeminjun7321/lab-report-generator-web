// 재조판(re-typeset) PDF: Claude가 만든 한국어 LaTeX 본문을 고정 프리앰블로 감싸
// Tectonic(self-contained XeLaTeX)으로 컴파일해 PDF 를 만든다.
//
// 왜 Tectonic: 단일 바이너리(TeX Live 전체보다 가벼움), 필요한 패키지를 처음
// 실행 때만 받아 캐시한다. 한글 폰트는 시스템 설치 없이 **번들 .ttf 를 경로로
// 지정**(fontspec Path=)해서 쓰므로 Render 에서도 폰트 의존성이 없다.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const FONT_DIR = path.join(__dirname, "../../fonts");
// 본문 글꼴(번들). 명조가 있으면 명조, 없으면 NanumGothic.
const SERIF = fs.existsSync(path.join(FONT_DIR, "NanumMyeongjo-Regular.ttf"))
  ? "NanumMyeongjo-Regular.ttf"
  : "NanumGothic-Regular.ttf";

function detectTectonic() {
  if (process.env.TECTONIC_BIN) return process.env.TECTONIC_BIN;
  const local = path.resolve(process.cwd(), "bin/tectonic");
  if (fs.existsSync(local)) return local;
  return "tectonic"; // PATH
}
const TECTONIC = detectTectonic();

// Claude 본문(\section/\[...\] 등 LaTeX)에 고정 프리앰블을 씌운다.
// title/author/date 는 인자로 받아 \maketitle 로.
function buildTex({ body, title = "", author = "", date = "" }) {
  return `\\documentclass[11pt]{article}
\\usepackage{fontspec}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage[a4paper,margin=2.5cm]{geometry}
\\usepackage{setspace}
\\usepackage{indentfirst}
\\usepackage{graphicx}
\\setmainfont{${SERIF}}[Path=${FONT_DIR}/]
\\onehalfspacing
\\setlength{\\parskip}{0.35em}
\\setlength{\\parindent}{1.1em}
\\title{${title || "번역"}}
\\author{${author}}
\\date{${date}}
\\begin{document}
${title ? "\\maketitle" : ""}
${body}
\\end{document}
`;
}

// .tex 문자열 → PDF Buffer. signal 로 중단 가능.
// assets: [{name, buffer}] — .tex 와 같은 디렉터리에 써서 \includegraphics 가 찾게 한다.
function compileTex(texSource, { signal, onProgress = () => {}, assets = [] } = {}) {
  return new Promise((resolve, reject) => {
    // 전용 하위 디렉터리(.tex + 그림 에셋). \includegraphics 는 .tex 위치 기준으로 해석.
    const dir = path.join(
      os.tmpdir(),
      `ltx-${crypto.randomBytes(8).toString("hex")}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    const texPath = path.join(dir, "doc.tex");
    const pdfPath = path.join(dir, "doc.pdf");
    fs.writeFileSync(texPath, texSource, "utf8");
    for (const a of assets || []) {
      if (a && a.name && a.buffer) {
        try {
          fs.writeFileSync(path.join(dir, a.name), a.buffer);
        } catch {
          /* 에셋 쓰기 실패 시 그 그림만 빠짐(컴파일은 진행) */
        }
      }
    }

    // Tectonic: 처음 실행 시 패키지 다운로드(캐시됨).
    const args = ["-X", "compile", texPath, "--outdir", dir, "--keep-logs"];
    onProgress("📐 LaTeX 컴파일 중 (Tectonic)...");
    const proc = spawn(TECTONIC, args, { stdio: ["ignore", "pipe", "pipe"] });
    const err = [];
    proc.stdout.on("data", () => {});
    proc.stderr.on("data", (c) => err.push(c));
    proc.on("error", (e) =>
      reject(
        new Error(
          `Tectonic 실행 실패: ${e.message} (TECTONIC_BIN=${TECTONIC}). 서버에 Tectonic 설치 필요.`,
        ),
      ),
    );
    proc.on("close", (code) => {
      const cleanup = () => {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      };
      if (code !== 0 || !fs.existsSync(pdfPath)) {
        const log = Buffer.concat(err).toString("utf8");
        cleanup();
        return reject(
          new Error(`LaTeX 컴파일 실패 (code ${code}): ${log.slice(-800)}`),
        );
      }
      const pdf = fs.readFileSync(pdfPath);
      cleanup();
      resolve(pdf);
    });

    if (signal) {
      if (signal.aborted) proc.kill("SIGKILL");
      else signal.addEventListener("abort", () => proc.kill("SIGKILL"), { once: true });
    }
  });
}

module.exports = { buildTex, compileTex, SERIF, TECTONIC };
