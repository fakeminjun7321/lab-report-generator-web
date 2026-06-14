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
// 본문 글꼴(번들). 고가독성 Pretendard 우선, 없으면 NanumGothic.
const SERIF = fs.existsSync(path.join(FONT_DIR, "Pretendard-Regular.ttf"))
  ? "Pretendard-Regular.ttf"
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
function buildTex({ body, title = "", author = "", date = "", twoColumn = false }) {
  // 2단 원문이면 출력도 2단으로(원본 배치 보존). 2단은 줄폭이 좁아 줄간격을 조금
  // 줄이고 여백을 좁힌다. \maketitle 은 2단에서도 상단 전폭에 제목을 둔다.
  const docOpts = twoColumn ? "11pt,twocolumn" : "11pt";
  const margin = twoColumn ? "1.8cm" : "2.5cm";
  const spacing = twoColumn ? "\\onehalfspacing" : "\\onehalfspacing";
  return `\\documentclass[${docOpts}]{article}
\\usepackage{fontspec}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage[a4paper,margin=${margin}]{geometry}
\\usepackage{setspace}
\\usepackage{indentfirst}
\\usepackage{graphicx}
\\setmainfont{${SERIF}}[Path=${FONT_DIR}/]
${spacing}
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

// 신뢰할 수 없는(모델 생성) LaTeX 소스에서 파일 입출력/셸 프리미티브를 무력화한다.
// 번역 대상 PDF 본문이 번역 모델을 프롬프트 인젝션해 \input{/etc/passwd} 같은
// 절대경로 파일 읽기나 셸 명령을 끼워넣을 수 있다. Tectonic --untrusted 는
// shell-escape 만 막고 \input 류 '파일 읽기'는 (경고만 내고) 막지 못함이 0.16.9 에서
// 실측되었으므로, 소스 단에서 위험 명령 자체를 제거한다.
// 보존: \includegraphics(정상 그림 복원), \usepackage(번들 패키지), \input 이 아닌
//   \inputencoding·\include 가 아닌 \includegraphics 등 letter 가 이어지는 명령.
function sanitizeUntrustedTex(src) {
  if (typeof src !== "string") return { text: src, neutralized: 0 };
  let n = 0;
  const bump = () => {
    n++;
    return "\\relax ";
  };
  const text = src
    // 셸 명령 실행: \write18 / \immediate\write18
    .replace(/\\(?:immediate\s*)?write\s*18\b/gi, bump)
    // 파일 읽기/쓰기/스트림: \input \include(≠graphics) \InputIfFileExists
    //   \openin \openout \read \write \subfile \subfileinclude \special
    .replace(
      /\\(?:input|include(?!graphics)|InputIfFileExists|openin|openout|read|write|subfile|subfileinclude|special)(?![a-zA-Z])/g,
      bump,
    );
  return { text, neutralized: n };
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
    // 신뢰 불가 소스의 파일 입출력/셸 프리미티브 제거(주 가드). --untrusted 는 보조.
    const { text: safeSource, neutralized } = sanitizeUntrustedTex(texSource);
    if (neutralized > 0) {
      onProgress(`🔒 LaTeX 보안 정리: 위험 명령 ${neutralized}개 무력화`);
    }
    fs.writeFileSync(texPath, safeSource, "utf8");
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
    // --untrusted: shell-escape 등 known-insecure 기능 차단(보조 방어). 단 절대경로
    //   \input 파일 읽기는 --untrusted 로 막히지 않으므로(0.16.9 실측), 위의
    //   sanitizeUntrustedTex 가 소스 단에서 파일 입출력 명령을 제거하는 것이 주 방어다.
    //   \includegraphics 의 정상 에셋은 .tex 와 같은 dir 에 쓰므로 계속 동작한다.
    const args = [
      "-X",
      "compile",
      texPath,
      "--outdir",
      dir,
      "--untrusted",
      "--keep-logs",
    ];
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

module.exports = { buildTex, compileTex, sanitizeUntrustedTex, SERIF, TECTONIC };
