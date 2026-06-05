#!/usr/bin/env python3
"""PDF 통번역기 — 레이아웃/그림은 유지하고 텍스트만 교체한다.

DeepL 문서 번역과 같은 방식: 디지털 PDF(텍스트 레이어가 있는 PDF)에서 문단
단위로 텍스트를 추출하고, 같은 위치(bounding box)에 번역문을 다시 끼워넣는다.
그림·도표·벡터 그래픽은 손대지 않으므로 그대로 보존된다.

두 가지 모드로 동작한다 (Node가 두 번 spawn 한다):

  python translate_pdf.py extract <pdf_path>
      → stdout JSON: {"page_count": N, "scanned": bool,
                      "blocks": [{"id": int, "page": int, "text": str}, ...]}
      번역이 필요한 문단만 내보낸다. Node가 이걸 Claude로 번역한다.

  python translate_pdf.py render <pdf_path> <out_path> <font_path>
      ← stdin JSON: {"translations": {"<id>": "<korean text>", ...}}
      → out_path 에 번역된 PDF 저장
      → stdout JSON: {"ok": true, "replaced": int, "shrunk": int}

블록 id는 두 모드에서 동일한 순서로 매겨진다(같은 파일 → 같은 get_text 순서).
그래서 extract가 부여한 id를 render가 그대로 다시 계산해 매칭할 수 있다.
"""

import sys
import os
import re
import json
from collections import defaultdict

import fitz  # PyMuPDF


def iter_text_blocks(doc):
    """type=0(텍스트) 블록을 두 모드에서 동일한 순서/id로 순회한다.

    span 이 없는 빈 블록과 이미지 블록(type=1)은 건너뛰되, id 카운터는
    '텍스트 블록'에 대해서만 증가시켜 extract/render 간 id 가 일치하게 한다.
    """
    bid = 0
    for pno in range(len(doc)):
        page = doc[pno]
        data = page.get_text("dict")
        for block in data.get("blocks", []):
            if block.get("type") != 0:
                continue
            lines = block.get("lines") or []
            if not any(ln.get("spans") for ln in lines):
                continue
            yield bid, pno, block
            bid += 1


# 깨진 ToUnicode 복원 — 폰트 자체 인코딩(/Differences)을 읽어 정확히 되돌린다.
#
# 일부 PDF(교재·원서)는 본문 합자(fi·fl)나 수식 폰트(MathematicalPi/MathPi)의
# 그리스·기호가 /ToUnicode 손상으로 ASCII('#', '"', '!' …)로 추출된다. 깨진 추출은
# ord(글자)==폰트코드 이므로, 그 폰트의 /Encoding /Differences(코드→글리프명)를 읽어
# 글리프명→유니코드로 매핑하면 서브셋·PDF 와 무관하게 정확히 복원된다(정적 char 맵은
# 서브셋마다 인코딩이 달라 오작동했음 — 이 방식이 그걸 대체한다).

# 합자(ligature) — 본문 폰트에서 'fi','fl' 등이 한 글리프로 묶인 것.
_LIG = {
    "f_i": "fi", "f_l": "fl", "f_f": "ff", "f_f_i": "ffi", "f_f_l": "ffl",
    "fi": "fi", "fl": "fl", "ff": "ff", "ffi": "ffi", "ffl": "ffl",
}

# MathematicalPi / MathPi 의 Hxxxxx 글리프명 → 유니코드.
# Oxtoby 6장에서 임베드 폰트 렌더로 식별(서브셋 무관 고정값). 교차검증:
#   ℋ_el ψ_el = E_el ψ_el (슈뢰딩거식) · 1σg < 1σu* (에너지 순서) · 4πε₀ (쿨롱)
#   + chem-pre 정적맵(33→+,34→Δ,35→−)이 H11001/H9004/H11002 와 일치.
_HCODE = {
    "H9274": "ψ", "H9278": "φ", "H9272": "φ", "H9268": "σ", "H9266": "π",
    "H9280": "ε", "H9258": "θ", "H9004": "Δ", "H11001": "+", "H11002": "−",
    "H11005": "=", "H11006": "±", "H11021": "<", "H11009": "∞", "H5108": "ℋ",
    "H11545": "+", "H11546": "−",
}

# Adobe Glyph List 부분집합(자주 쓰는 그리스·수학 기호·연산자).
_AGL = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
    "zeta": "ζ", "eta": "η", "theta": "θ", "iota": "ι", "kappa": "κ",
    "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "omicron": "ο", "pi": "π",
    "rho": "ρ", "sigma": "σ", "tau": "τ", "upsilon": "υ", "phi": "φ", "chi": "χ",
    "psi": "ψ", "omega": "ω", "varphi": "φ", "varepsilon": "ε", "vartheta": "ϑ",
    "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ",
    "Pi": "Π", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
    "Upsilon": "Υ", "plus": "+", "minus": "−", "equal": "=", "plusminus": "±",
    "minusplus": "∓", "multiply": "×", "divide": "÷", "less": "<",
    "greater": ">", "lessequal": "≤", "greaterequal": "≥", "notequal": "≠",
    "approxequal": "≈", "equivalence": "≡", "proportional": "∝", "infinity": "∞",
    "partialdiff": "∂", "gradient": "∇", "integral": "∫", "summation": "∑",
    "product": "∏", "radical": "√", "element": "∈", "notelement": "∉",
    "arrowright": "→", "arrowleft": "←", "arrowboth": "↔", "arrowup": "↑",
    "arrowdown": "↓", "asteriskmath": "*", "bullet": "•", "periodcentered": "·",
    "dotmath": "·", "degree": "°", "minute": "′", "second": "″", "angle": "∠",
    "bracketleft": "[", "bracketright": "]", "parenleft": "(", "parenright": ")",
    "braceleft": "{", "braceright": "}",
}

# 폴백: Computer Modern / AMS 수식 폰트(LaTeX 논문)는 /Differences 글리프명이
# 비표준일 수 있어 디코더가 못 풀 때만 쓴다. 기호 전용이라 안전.
_CMSY_FIX = {"⇤": "*", "⇥": "×", "2": "∈", "p": "√"}
_CMEX_FIX = {"P": "Σ"}
_CMMI_FIX = {"↵": "α", "⇡": "π", "✏": "ε"}

# 수식·기호 전용 폰트(이 폰트의 슬롯은 전부 기호 → /Differences 전부 적용 안전).
_MATH_FONT_KEYS = (
    "MathematicalPi", "MathPi", "Symbol", "Euclid", "MT-Extra",
    "CMSY", "CMEX", "CMMI", "MSAM", "MSBM",
)

# 디코더는 페이지별로 만든다 — 같은 수식폰트도 서브셋마다 인코딩이 달라(코드 33이
# ψ/θ/σ …) 문서 전역 매핑은 오작동한다. 페이지의 폰트(서브셋)만으로 매핑하면 그 페이지
# 본문은 정확히 복원된다. 같은 페이지에 충돌 서브셋이 여럿이면 가장 풍부한(=본문) 것을
# 우선한다(span→서브셋 식별은 PyMuPDF API 로 불가능 — 그림 라벨 등은 한계가 남음).
_DECODERS_BY_PAGE = {}  # {pno: {정규화폰트명: {코드: 유니코드}}}
_CUR_DEC = {}  # 현재 페이지 디코더


def _norm_font(n):
    return (n or "").split("+")[-1]  # 서브셋 접두사(ABCDEF+) 제거


def _use_page(pno):
    """추출 시 현재 페이지의 디코더를 활성화(_fix_span_text 가 참조)."""
    global _CUR_DEC
    _CUR_DEC = _DECODERS_BY_PAGE.get(pno, {})


def _glyph_to_unicode(gn):
    """글리프명 → 유니코드 문자(또는 None: 못 풀면 원본 유지)."""
    if not gn:
        return None
    if gn in _HCODE:
        return _HCODE[gn]
    if gn in _LIG:
        return _LIG[gn]
    if gn in _AGL:
        return _AGL[gn]
    m = re.match(r"^uni([0-9A-Fa-f]{4,6})$", gn) or re.match(r"^u([0-9A-Fa-f]{4,6})$", gn)
    if m:
        try:
            return chr(int(m.group(1), 16))
        except Exception:
            return None
    for k, v in (("bracketleft", "["), ("bracketright", "]"), ("parenleft", "("),
                 ("parenright", ")"), ("braceleft", "{"), ("braceright", "}"),
                 ("arrowright", "→"), ("arrowleft", "←"), ("radical", "√")):
        if gn.startswith(k):
            return v
    base = gn.split(".")[0]  # .sc/.sup 등 접미사 제거 후 재시도
    if base != gn:
        return _glyph_to_unicode(base)
    return None


def _read_differences(doc, xref):
    """폰트 객체의 /Encoding /Differences 를 읽어 {코드: 글리프명} 반환."""
    try:
        obj = doc.xref_object(xref) or ""
    except Exception:
        return {}
    blob = obj
    m = re.search(r"/Encoding\s+(\d+)\s+0\s+R", obj)
    if m:
        try:
            blob = doc.xref_object(int(m.group(1))) or obj
        except Exception:
            pass
    dm = re.search(r"/Differences\s*\[(.*?)\]", blob, re.S)
    if not dm and blob != obj:
        dm = re.search(r"/Differences\s*\[(.*?)\]", obj, re.S)
    if not dm:
        return {}
    code = None
    mp = {}
    for t in dm.group(1).split():
        if t.isdigit():
            code = int(t)
        elif t.startswith("/") and code is not None:
            mp[code] = t[1:]
            code += 1
    return mp


def build_decoders(doc):
    """페이지별로 폰트 /Differences → code→유니코드 디코더를 만든다.
    - 수식 폰트(MathematicalPi/MathPi/Symbol/Euclid/CM…): /Differences 전부 적용(모두 기호).
    - 본문 폰트: 합자(다중 글자) 매핑만 적용 — 진짜 따옴표·문장부호 오염 방지.
    - 같은 페이지에 같은 base 폰트의 서브셋이 여럿이고 코드가 충돌하면, /Differences 가
      가장 큰(가장 풍부 = 본문) 서브셋을 우선하고 나머지는 비충돌 코드만 보충한다."""
    global _DECODERS_BY_PAGE
    _DECODERS_BY_PAGE = {}
    for pno in range(len(doc)):
        try:
            fonts = doc[pno].get_fonts(full=True)
        except Exception:
            _DECODERS_BY_PAGE[pno] = {}
            continue
        bysub = {}  # 정규화명 -> [cmap(code→글리프명), ...]
        for f in fonts:
            name = _norm_font(f[3] if len(f) > 3 else "")
            if not name:
                continue
            cmap = _read_differences(doc, f[0])
            if cmap:
                bysub.setdefault(name, []).append(cmap)
        page_dec = {}
        for name, cmaps in bysub.items():
            is_math = any(k in name for k in _MATH_FONT_KEYS)
            # 가장 풍부한 서브셋(=본문) 우선, 충돌하지 않는 코드만 다른 서브셋서 보충.
            merged = {}
            for cmap in sorted(cmaps, key=lambda m: -len(m)):
                for code, gname in cmap.items():
                    merged.setdefault(code, gname)
            dec = {}
            for code, gname in merged.items():
                u = _glyph_to_unicode(gname)
                if u is None:
                    continue
                if is_math or len(u) > 1:  # 본문 폰트는 합자(다중 글자)만
                    dec[code] = u
            if dec:
                page_dec[name] = dec
        _DECODERS_BY_PAGE[pno] = page_dec
    return _DECODERS_BY_PAGE


def _fix_span_text(font, text):
    """깨진 글자를 실제 유니코드로 복원. 폰트 /Differences 디코더 우선,
    못 풀면 CM 정적맵 폴백. 일반 본문 폰트의 진짜 글자는 건드리지 않는다."""
    if not text:
        return text
    f = font or ""
    dec = _CUR_DEC.get(_norm_font(f))
    out = []
    for ch in text:
        if dec is not None:
            u = dec.get(ord(ch))
            if u is not None:
                out.append(u)
                continue
        if "CMSY" in f:
            out.append(_CMSY_FIX.get(ch, ch))
        elif "CMEX" in f:
            out.append(_CMEX_FIX.get(ch, ch))
        elif "CMMI" in f:
            out.append(_CMMI_FIX.get(ch, ch))
        else:
            out.append(ch)
    return "".join(out)


def _line_in_figs(line_bbox, figs):
    """줄(line)의 중심이 그림 영역(±18pt) 안이면 True.

    그래프 Y축 라벨 'V(R_AB)' 처럼, PyMuPDF 가 그림 위 텍스트를 캡션과 같은
    블록으로 묶어버리는 경우가 있다. 그런 줄을 가려내 번역·덮기에서 빼면
    축 라벨은 영어 그대로 그래프에 남고, 캡션만 깔끔히 번역된다.
    """
    if not figs:
        return False
    cx = (line_bbox[0] + line_bbox[2]) / 2.0
    cy = (line_bbox[1] + line_bbox[3]) / 2.0
    return any(
        (f.x0 - 18) <= cx <= (f.x1 + 18) and (f.y0 - 18) <= cy <= (f.y1 + 18)
        for f in figs
    )


def block_text(block, figs=None):
    """블록 안의 줄들을 사람이 읽을 한 문단 문자열로 합친다.

    화면상 줄바꿈(wrap)은 공백으로 이어 붙인다 — 한 문장이 여러 줄에 걸쳐도
    번역은 한 단위로 처리해야 자연스럽기 때문이다.

    figs 가 주어지면, 그림 영역에 든 줄(축 라벨 등)은 번역 대상에서 제외한다.
    """
    lines = []
    for ln in block.get("lines", []):
        if _line_in_figs(ln.get("bbox", (0, 0, 0, 0)), figs):
            continue
        s = "".join(
            _fix_span_text(sp.get("font", ""), sp.get("text", ""))
            for sp in ln.get("spans", [])
        )
        if s.strip():
            lines.append(s.strip())
    return " ".join(lines).strip()


def _nonfig_rect(block, figs=None):
    """그림 영역 줄을 뺀, '번역 대상 줄들'만의 bbox.

    render 가 이 사각형만 덮고/그리도록 해서, 캡션에 붙어 있던 축 라벨(V(R_AB))을
    지우거나 그 위에 한글을 그리지 않게 한다(축 라벨은 영어 원본 그대로 유지).
    """
    r = None
    for ln in block.get("lines", []):
        if _line_in_figs(ln.get("bbox", (0, 0, 0, 0)), figs):
            continue
        lr = fitz.Rect(ln["bbox"])
        r = lr if r is None else (r | lr)
    return r if r is not None else fitz.Rect(block["bbox"])


_BOLD_NAME = ("bold", "black", "heavy", "semibold", "-bd", "-bold", "medi")
_ITAL_NAME = ("italic", "oblique", "-it", "-ital")


def dominant_size_color(block):
    """글자 수 기준으로 가장 많이 쓰인 폰트 크기·색과, 블록의 볼드/이탤릭 여부를 고른다.

    본문은 보통 단일 크기/색이고, 제목 블록은 그 블록의 크기를 따른다. 굵게/기울임은
    span flags(16=bold, 2=italic) + 폰트명으로 판정하며, 블록 글자의 과반이 그 스타일일
    때 True(제목·강조 줄을 번역본에도 굵게/기울임으로 반영).
    """
    sizes = defaultdict(float)
    colors = defaultdict(float)
    bold_n = ital_n = total_n = 0.0
    for ln in block.get("lines", []):
        for sp in ln.get("spans", []):
            n = max(1, len(sp.get("text", "")))
            sizes[round(float(sp.get("size", 10.0)), 1)] += n
            colors[int(sp.get("color", 0))] += n
            flags = int(sp.get("flags", 0))
            fn = (sp.get("font", "") or "").lower()
            if (flags & 16) or any(k in fn for k in _BOLD_NAME):
                bold_n += n
            if (flags & 2) or any(k in fn for k in _ITAL_NAME):
                ital_n += n
            total_n += n
    size = max(sizes, key=sizes.get) if sizes else 10.0
    color = max(colors, key=colors.get) if colors else 0
    bold = total_n > 0 and bold_n >= 0.6 * total_n
    italic = total_n > 0 and ital_n >= 0.6 * total_n
    return size, color, bold, italic


def has_letters(s):
    """알파벳/한글 등 '글자'가 하나라도 있는지. 순수 숫자·기호 블록은 번역 제외."""
    return any(ch.isalpha() for ch in s)


def _is_symbol_label(block, max_len=10):
    """짧고 수식폰트 기호를 포함하며 '단어'가 없는 블록 = 오비탈/기호 라벨
    (예: 1σg, 3σ*u, 1πu, σg1s). 디지트+g/u 첨자가 섞여 기호 비중은 낮지만 라벨이다.

    이런 라벨은 번역이 불필요하고(σ/π 는 한국어도 동일), 깨진 추출+서브셋 충돌로
    ψ/φ 처럼 오역될 위험이 크다. 추출에서 제외하면 재그리기를 안 해 **원본 글리프가
    그대로** 보여(σ/π 정확) 그림·본문 기호 라벨이 깨지지 않는다."""
    has_math = False
    chars = []
    for ln in block.get("lines", []):
        for sp in ln.get("spans", []):
            is_math = any(k in sp.get("font", "") for k in _MATH_FONT_KEYS)
            for c in sp.get("text", ""):
                if c.isspace():
                    continue
                chars.append(c)
                if len(chars) > max_len + 2:
                    return False  # 길면 일반 본문 — 라벨 아님
                if is_math:
                    has_math = True
    if not chars or not has_math:
        return False
    s = "".join(chars)
    # 3글자 이상 연속 ASCII 알파벳(=단어)이 있으면 본문 문장 — 라벨 아님.
    if re.search(r"[A-Za-z]{3,}", s):
        return False
    return True


# ── 배경색 샘플링 (그림/그래프 위 텍스트 판별 + 색 맞춤 redaction) ───────────────
def _sample_pixmap(page):
    """배경색 샘플링용 페이지 픽스맵(zoom 1 → 1pt = 1px, 좌표 그대로 사용)."""
    return page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)


def _quant(px):
    return (px[0] // 16 * 16, px[1] // 16 * 16, px[2] // 16 * 16)


def _bg_in_rect(pix, rect):
    """rect 영역의 최빈색(=배경; 글자 잉크는 소수) 추정. 실패 시 None."""
    x0, y0 = max(0, int(rect.x0)), max(0, int(rect.y0))
    x1, y1 = min(pix.width, int(rect.x1)), min(pix.height, int(rect.y1))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    counts = {}
    sx, sy = max(1, (x1 - x0) // 12), max(1, (y1 - y0) // 6)
    yy = y0
    while yy < y1:
        xx = x0
        while xx < x1:
            try:
                q = _quant(pix.pixel(xx, yy))
                counts[q] = counts.get(q, 0) + 1
            except Exception:
                pass
            xx += sx
        yy += sy
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _page_bg(pix):
    """모서리·여백 픽셀의 최빈색 = 페이지 배경색."""
    w, h = pix.width, pix.height
    pts = []
    for xx, yy in [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3), (w // 2, 2), (2, h // 2)]:
        try:
            pts.append(_quant(pix.pixel(xx, yy)))
        except Exception:
            pass
    if not pts:
        return (240, 240, 240)
    counts = {}
    for p in pts:
        counts[p] = counts.get(p, 0) + 1
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _cdist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def _bg_around(pix, rect, m=3):
    """블록 '바로 바깥' 테두리의 정확한 최빈색 = 주변 배경색(글자 잉크가 없어 깨끗).
    이 색으로 덮으면 redaction 이 주변과 똑같아져 '상자' 경계가 안 보인다."""
    x0, y0, x1, y1 = int(rect.x0), int(rect.y0), int(rect.x1), int(rect.y1)
    W, H = pix.width, pix.height
    counts = {}

    def add(x, y):
        if 0 <= x < W and 0 <= y < H:
            try:
                p = pix.pixel(x, y)
                counts[p] = counts.get(p, 0) + 1
            except Exception:
                pass

    sy = max(1, (y1 - y0) // 8)
    sx = max(1, (x1 - x0) // 12)
    y = y0
    while y < y1:
        add(x0 - m, y)
        add(x1 + m - 1, y)
        y += sy
    x = x0
    while x < x1:
        add(x, y0 - m)
        add(x, y1 + m - 1)
        x += sx
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]  # 정확한 색(양자화 안 함)


def _cluster_rects(rects, gap=18.0):
    """가까운 사각형들을 묶는다(1패스 greedy). 그래프 라인아트 영역 잡기용."""
    clusters = []
    for r in rects:
        placed = False
        for c in clusters:
            cb = c["bbox"]
            if fitz.Rect(cb.x0 - gap, cb.y0 - gap, cb.x1 + gap, cb.y1 + gap).intersects(r):
                c["bbox"] = cb | r
                c["n"] += 1
                placed = True
                break
        if not placed:
            clusters.append({"bbox": fitz.Rect(r), "n": 1})
    return clusters


def _figure_regions(page):
    """그림/그래프 영역 = 이미지 + '윤곽선' vector drawing(선·곡선·축·화살표·격자)을
    함께 묶은 클러스터. 배경 채움(fill-only) 사각형(색 배너 등)은 제외 → 배너 위 본문을
    figure 로 오인하지 않는다. 얇은 선(축 등)도 포함해야 그래프가 잡힌다."""
    elems = []
    try:
        for im in page.get_images(full=True):
            for r in page.get_image_rects(im[0]):
                elems.append(fitz.Rect(r))
    except Exception:
        pass
    try:
        for d in page.get_drawings():
            if "s" in (d.get("type") or ""):  # 윤곽선 path
                elems.append(fitz.Rect(d["rect"]))
    except Exception:
        pass
    page_area = page.rect.width * page.rect.height
    regions = []
    for c in _cluster_rects(elems):
        b = c["bbox"]
        if (
            c["n"] >= 4
            and b.width > 50
            and b.height > 50
            and b.width * b.height < 0.88 * page_area
        ):
            regions.append(b)
    return regions


def _table_regions(page, min_rules=2):
    """가로 rule(테두리 선)로 표 영역을 추정한다. PyMuPDF find_tables 가 못 잡는
    booktabs형(세로선 없이 가로줄만 있는) 표를 잡기 위함. 인접한(가로로 겹치고 가까운)
    가로줄 ≥2개가 만드는 세로 구간을 표로 본다 → in-place 가 표 셀을 줄글로 뭉개지
    않도록 그 영역 텍스트를 영어 원본 그대로 둔다(그림과 동일 취급)."""
    W = page.rect.width
    H = page.rect.height
    rules = []  # (x0, y, x1) 가로줄
    try:
        for dr in page.get_drawings():
            for it in dr.get("items", []):
                if it[0] == "l":  # line
                    p1, p2 = it[1], it[2]
                    if abs(p1.y - p2.y) < 1.6 and abs(p2.x - p1.x) > 0.22 * W:
                        rules.append(
                            (min(p1.x, p2.x), (p1.y + p2.y) / 2.0, max(p1.x, p2.x))
                        )
                elif it[0] == "re":  # 얇은 사각형 = 가로줄
                    r = fitz.Rect(it[1])
                    if r.height < 2.2 and r.width > 0.22 * W:
                        rules.append((r.x0, (r.y0 + r.y1) / 2.0, r.x1))
    except Exception:
        return []
    if len(rules) < min_rules:
        return []
    rules.sort(key=lambda t: t[1])
    # 가로로 겹치고 세로로 가까운(<230pt) 줄들을 한 표로 묶는다.
    groups = [[rules[0]]]
    for r in rules[1:]:
        prev = groups[-1][-1]
        ox = min(r[2], prev[2]) - max(r[0], prev[0])
        minw = max(1.0, min(r[2] - r[0], prev[2] - prev[0]))
        if ox > 0.5 * minw and (r[1] - prev[1]) < 230:
            groups[-1].append(r)
        else:
            groups.append([r])
    out = []
    for g in groups:
        if len(g) < min_rules:
            continue
        x0 = min(r[0] for r in g)
        x1 = max(r[2] for r in g)
        y0 = min(r[1] for r in g)
        y1 = max(r[1] for r in g)
        if (x1 - x0) > 0.2 * W and 4 < (y1 - y0) < 0.85 * H:
            out.append(fitz.Rect(x0, y0, x1, y1))
    return out


def _skip_regions(page):
    """번역 제외 영역 = 그림/그래프 + 표. 두 경우 모두 영역 안 텍스트는 영어 원본 유지."""
    return _figure_regions(page) + _table_regions(page)


def cmd_extract(pdf_path):
    doc = fitz.open(pdf_path)
    build_decoders(doc)  # 폰트 /Differences 디코더(깨진 글자 복원) — 추출 전에 준비
    blocks = []
    total_text_chars = 0
    # 페이지별 figure 영역(이미지 + 그래프 라인아트) 캐시 — 그림 위 텍스트 판별용.
    page_cache = {}

    def regions(pno):
        if pno not in page_cache:
            page_cache[pno] = _skip_regions(doc[pno])  # 그림 + 표
        return page_cache[pno]

    for bid, pno, block in iter_text_blocks(doc):
        _use_page(pno)  # 이 페이지의 폰트 디코더 활성화(깨진 글자 복원)
        regs = regions(pno)
        # 그림/그래프 영역에 든 '줄'(축 라벨·기호·분자식 등)은 빼고 합친다.
        # → 캡션과 한 블록에 묶인 'V(R_AB)' 같은 축 라벨이 번역문에 섞이지 않는다.
        text = block_text(block, regs)
        if not text or not has_letters(text):
            continue  # 모든 줄이 그림 영역이면 text 가 비어 자동 제외(그래프 라벨 등)
        if _is_symbol_label(block):
            continue  # 기호/오비탈 라벨(1σg 등) → 원본 글리프 유지(재그리기·오역 방지)
        total_text_chars += len(text)  # scanned 판정엔 모든 글자 포함
        # 그림 근처의 '짧은' 블록(축 끝 라벨 RAB 등)은 그대로 영어로 둔다.
        # 번역 대상 줄들만의 bbox 로 판정(그림 줄은 이미 빠짐).
        if len(text.strip()) <= 8:
            rect = _nonfig_rect(block, regs)
            cx, cy = (rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2
            near_fig = any(
                (reg.x0 - 40) <= cx <= (reg.x1 + 40)
                and (reg.y0 - 40) <= cy <= (reg.y1 + 40)
                for reg in regs
            )
            if near_fig:
                continue
        blocks.append({"id": bid, "page": pno, "text": text})
    # 텍스트가 거의 없으면 스캔본(글자가 이미지)일 가능성이 높다 → Node가 안내.
    scanned = len(doc) > 0 and total_text_chars < 20 * len(doc)
    # 진단: 그림/표 영역 감지 수 + PyMuPDF 버전(서버/로컬 동작 차이 추적용)
    fig_regions = 0
    table_regions = 0
    for pg in range(len(doc)):
        try:
            fig_regions += len(_figure_regions(doc[pg]))
            table_regions += len(_table_regions(doc[pg]))
        except Exception:
            pass
    try:
        fitz_ver = fitz.version[0]
    except Exception:
        fitz_ver = "?"
    out = {
        "page_count": len(doc),
        "scanned": scanned,
        "blocks": blocks,
        "fig_regions": fig_regions,
        "table_regions": table_regions,
        "fitz": fitz_ver,
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    doc.close()


_MATH_SYMS = "∑∫√±×÷≤≥≠≈∞∂∇·°→←↔⟨⟩∝∈∉⊂⊃∪∩∀∃∮∇µΩ"


def _detect_two_column(doc, _frac=(0.2, 0.35, 0.5, 0.65, 0.8)):
    """본문 페이지의 텍스트 줄 가로 분포로 2단 레이아웃을 추정한다(ML 없이).

    전폭(페이지 폭의 60%+) 줄이 거의 없고, 좌측 전용/우측 전용 줄이 양쪽으로
    충분히 나뉘면 2단으로 본다. 표지·참고문헌 페이지에 흔들리지 않도록 문서 중앙
    표본 페이지들의 과반 동의가 있을 때만 True.
    """
    n = len(doc)
    if n == 0:
        return False
    idxs = sorted(set(min(n - 1, max(0, int(n * f))) for f in _frac))
    votes = 0
    counted = 0
    for pi in idxs:
        page = doc[pi]
        W = page.rect.width
        if W <= 0:
            continue
        lines = []
        for b in page.get_text("dict").get("blocks", []):
            for l in b.get("lines", []):
                x0, _, x1, _ = l["bbox"]
                if x1 - x0 > 2:
                    lines.append((x0, x1))
        if len(lines) < 12:
            continue  # 본문이 적은 페이지는 판정에서 제외
        counted += 1
        m = len(lines)
        full = sum(1 for x0, x1 in lines if (x1 - x0) > 0.6 * W)
        left = sum(1 for x0, x1 in lines if x1 < 0.55 * W)
        right = sum(1 for x0, x1 in lines if x0 > 0.45 * W)
        if full <= 0.08 * m and left >= 0.25 * m and right >= 0.25 * m:
            votes += 1
    return counted >= 2 and votes >= max(1, counted // 2 + counted % 2)


def cmd_analyze(pdf_path):
    """텍스트 레이어 유무 + 수식 밀도 + 2단 여부를 판정(자동 변환방식 선택용).
    scanned: 텍스트 레이어 없음(스캔/이미지). math_density: 1000자당 수식 지표 점수.
    two_column: 본문이 2단 레이아웃인지(재조판 시 2단 보존 + 읽기순서 보정용)."""
    doc = fitz.open(pdf_path)
    total = 0
    parts = []
    for page in doc:
        t = page.get_text("text") or ""
        total += len(t.strip())
        parts.append(t)
    text = "\n".join(parts)
    n = len(doc)
    scanned = n > 0 and total < 20 * n
    two_column = (not scanned) and _detect_two_column(doc)
    # 수식 지표: 그리스 문자(U+0370–03FF), 수학 기호, 위/아래 첨자(U+2070–209F), '=' 빈도
    greek = sum(1 for c in text if "Ͱ" <= c <= "Ͽ")
    syms = sum(1 for c in text if c in _MATH_SYMS)
    subsup = sum(1 for c in text if "⁰" <= c <= "₟")
    eqs = text.count("=")
    math_score = greek * 3 + syms * 3 + subsup * 2 + eqs
    density = round((math_score / max(total, 1)) * 1000, 2)
    sys.stdout.write(
        json.dumps(
            {
                "page_count": n,
                "text_chars": total,
                "scanned": scanned,
                "math_score": math_score,
                "math_density": density,
                "two_column": two_column,
            },
            ensure_ascii=False,
        )
    )
    doc.close()


def cmd_rasterize(pdf_path, out_dir, target_width_px=1400, max_pages=20):
    """각 페이지를 가독 가능한 PNG 타일로 렌더링한다(스캔본을 Claude 비전으로 읽히기 위함).

    핵심: 일부 PDF(문제집 등)는 한 페이지가 세로로 매우 길다(예: 958×11833). 이를 한 장
    이미지로 보내면 Claude 가 긴 변을 1568px 로 줄여 글자가 다시 뭉개진다. 그래서 폭을
    가독 해상도(≈target_width_px)로 맞춰 렌더하되, 세로로 긴 페이지는 페이지 모양 타일로
    잘라(겹침 포함) 각각 저장한다. clip 렌더라 거대한 픽스맵을 만들지 않는다."""
    target_width_px = int(target_width_px)
    max_pages = int(max_pages)
    tile_h_px = 1800       # 타일 1장의 최대 높이(px)
    overlap_px = 130       # 타일 경계에서 줄이 잘리지 않도록 겹침
    max_tiles_per_page = 30
    max_tiles_total = 100
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    n = len(doc)
    rendered = min(n, max_pages)
    files = []
    truncated = n > rendered
    for i in range(rendered):
        if len(files) >= max_tiles_total:
            truncated = True
            break
        page = doc[i]
        rect = page.rect
        w_pt = rect.width or 612.0
        h_pt = rect.height or 792.0
        zoom = target_width_px / w_pt
        zoom = max(1.0, min(zoom, 4.0))
        mat = fitz.Matrix(zoom, zoom)
        tile_h_pt = tile_h_px / zoom
        overlap_pt = overlap_px / zoom
        # 타일 수를 먼저 정해 '균등 분할'한다 → 얇은 자투리(앞 타일과 중복) 방지.
        # 1.15 여유: 한 타일보다 조금 더 긴 페이지(일반 A4 등)는 자르지 않고 1장으로.
        n_tiles = max(1, int(-(-h_pt // (tile_h_pt * 1.15))))  # ceil
        n_tiles = min(n_tiles, max_tiles_per_page)
        seg_pt = h_pt / n_tiles
        for t in range(n_tiles):
            if len(files) >= max_tiles_total:
                truncated = True
                break
            y0 = max(0.0, seg_pt * t - overlap_pt / 2)
            y1 = min(h_pt, seg_pt * (t + 1) + overlap_pt / 2)
            clip = fitz.Rect(rect.x0, rect.y0 + y0, rect.x1, rect.y0 + y1)
            pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
            out_path = os.path.join(out_dir, f"p-{i:03d}-{t:02d}.png")
            pix.save(out_path)
            files.append(out_path)
    sys.stdout.write(
        json.dumps(
            {
                "page_count": n,
                "rendered_pages": rendered,
                "tiles": len(files),
                "truncated": truncated,
                "target_width_px": target_width_px,
                "files": files,
            },
            ensure_ascii=False,
        )
    )
    doc.close()


def _color01(c):
    if isinstance(c, (list, tuple)):
        return tuple(float(x) for x in c[:3])
    c = int(c)
    return (((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255)


def _detect_align(rect, page_width, single_line=False):
    """원문 블록 위치로 정렬을 추정한다.

    제목/저자처럼 '좁고 + 좌우 여백이 거의 대칭'인 블록은 가운데 정렬,
    그 외(본문 컬럼)는 양끝맞춤(justify) — LaTeX 조판처럼 단정해진다.
    단, **한 줄짜리 블록**(저자·소속·짧은 라벨 등)은 justify 하면 단어 사이가
    크게 벌어진다('Google   Brain') → 좁으면 가운데, 넓으면 왼쪽으로 처리한다.
    """
    w = rect.x1 - rect.x0
    left = rect.x0
    right = page_width - rect.x1
    if (
        w < 0.62 * page_width
        and left > 0.15 * page_width
        and abs(left - right) < 0.06 * page_width
    ):
        return fitz.TEXT_ALIGN_CENTER
    # 좁은 칼럼(저자·소속·짧은 라벨; 본문 단보다 좁음)은 justify 하면 단어가 크게
    # 벌어진다('Google   Brain') → 가운데 정렬. 본문 단(2단≈0.4W, 1단≈0.7W)은 제외.
    if w < 0.30 * page_width:
        return fitz.TEXT_ALIGN_CENTER
    if single_line:
        return (
            fitz.TEXT_ALIGN_CENTER if w < 0.5 * page_width else fitz.TEXT_ALIGN_LEFT
        )
    return fitz.TEXT_ALIGN_JUSTIFY


def _has_leftover(ret):
    """TextWriter.fill_textbox 반환값(보통 leftover 리스트)에 '안 들어간 텍스트'가 있는지."""
    if not ret:
        return False
    if isinstance(ret, str):
        return bool(ret.strip())
    if isinstance(ret, (list, tuple)):
        return any(_has_leftover(x) for x in ret)
    return bool(ret)


def _draw_fit(
    page,
    rect,
    text,
    color,
    font,
    start_size,
    align,
    min_size=4.0,
    italic=False,
    max_x=None,
    max_y=None,
):
    """rect 안에 번역문을 그린다. TextWriter 는 write_text() 전엔 페이지에 안 그리므로
    fill_textbox 로 '다 들어갔는지' 먼저 확인하고 들어갈 때만 커밋한다(겹침·증발 방지).

    크기 정책 — 제목·헤딩이 번역으로 길어져도 작아지지 않게 하되 **이웃 블록을 절대
    침범하지 않는다**(겹침 방지):
    - 가로: 번역이 한 줄에 안 들어가면 오른쪽 여유(max_x: 오른쪽 이웃/페이지 여백)까지
      넓혀 한 줄에 담는다(가운데 정렬 제외). → 제목·헤딩이 크기 유지된 채 한 줄로.
    - 세로: 그래도 넘치면 아래 여유(max_y: 아래 이웃/페이지 여백)까지만 줄을 흘린다.
    - 가로·세로 여유로도 안 되면 그때만 폰트를 줄인다(이웃 침범 0).

    italic=True 면 전단(shear) morph 로 기울여 그려 원문 이탤릭을 반영한다(faux-oblique).
    """
    rect = fitz.Rect(rect)
    rect.normalize()
    if rect.width < 2 or rect.height < 1:
        return False
    page_rect = page.rect
    # 확장 상한 = 이웃 블록(없으면 페이지 여백). 최소 원래 크기는 보장.
    mx = max(rect.x1, max_x if max_x is not None else page_rect.x1 - 6)
    my = max(rect.y1, max_y if max_y is not None else page_rect.y1 - 6)

    morph = None
    if italic:
        morph = (fitz.Point(rect.x0, rect.y1), fitz.Matrix(1, 0, -0.28, 1, 0, 0))

    def _expand(r, fs):
        """한 줄에 안 들어가면 가로(→mx) 먼저, 그래도 넘치면 세로(→my)로만 확장.
        둘 다 이웃 한계 안이라 겹치지 않는다."""
        r = fitz.Rect(r)
        try:
            tl = font.text_length(text, fontsize=fs)
        except Exception:
            tl = 0.0
        # 가로 확장(가운데 정렬 제외): 1줄 폭이 모자라면 오른쪽 여유까지.
        if align != fitz.TEXT_ALIGN_CENTER and tl > r.width - 2 and mx > r.x1 + 1:
            r.x1 = mx
        # 한 줄 높이 보장(얇은 블록).
        lh = fs * 1.35
        if r.height < lh:
            r.y1 = max(r.y1, min(my, r.y0 + lh))
            if r.height < lh:
                r.y0 = max(page_rect.y0, r.y1 - lh)
        # 여전히 1줄 초과면 아래 여유까지만 늘려 wrap.
        if tl > r.width:
            need = (int(tl / max(1.0, r.width)) + 1) * fs * 1.32
            if need > r.height:
                r.y1 = min(my, r.y0 + need)
        return r

    def _try_fill(r, fs):
        try:
            tw = fitz.TextWriter(page_rect)
            leftover = tw.fill_textbox(r, text, font=font, fontsize=fs, align=align)
            return tw, leftover
        except (ValueError, RuntimeError):
            return None

    def _commit(tw):
        if morph is not None:
            try:
                tw.write_text(page, color=color, morph=morph)
                return
            except Exception:
                pass  # morph 실패 시 일반 그리기로 폴백
        tw.write_text(page, color=color)

    fs = max(min_size, min(float(start_size), 400.0))
    while fs >= min_size:
        res = _try_fill(_expand(rect, fs), fs)
        if res is not None and not _has_leftover(res[1]):
            _commit(res[0])
            return fs < float(start_size) - 0.01
        fs -= 0.5
    # 최소 크기로도 안 들어가면 들어가는 만큼이라도(예외 무시 → render 전체는 계속).
    res = _try_fill(_expand(rect, min_size), min_size)
    if res is not None:
        _commit(res[0])
    return True


def _clip_out(rect, regions):
    """rect 에서 figure 영역을 뺀 '그림 밖' 가장 큰 직사각형을 돌려준다(완전히 그림
    안이면 None). 캡션 bbox 가 그림 위로 뻗쳐도 그림 배경을 덮지 않게(흰 자국 방지) +
    그림 안 라벨(V(RAB) 등)은 원본 그대로 둔다."""
    r = fitz.Rect(rect)
    for f in regions:
        if not r.intersects(f):
            continue
        cands = []
        if f.x0 > r.x0:
            cands.append(fitz.Rect(r.x0, r.y0, min(r.x1, f.x0), r.y1))
        if f.x1 < r.x1:
            cands.append(fitz.Rect(max(r.x0, f.x1), r.y0, r.x1, r.y1))
        if f.y0 > r.y0:
            cands.append(fitz.Rect(r.x0, r.y0, r.x1, min(r.y1, f.y0)))
        if f.y1 < r.y1:
            cands.append(fitz.Rect(r.x0, max(r.y0, f.y1), r.x1, r.y1))
        cands = [c for c in cands if c.width > 2 and c.height > 2]
        if not cands:
            return None
        r = max(cands, key=lambda c: c.width * c.height)
    return r


def _dedoverlap_column(items):
    """같은 단(column)에서 세로로 겹치는 블록들을 중점에서 잘라 분리한다.
    원본 PDF 의 블록 bbox 가 위/아래첨자 경계(예: H₂⁺)에서 서로 겹치는 경우가 있어,
    그대로 두면 두 번역문이 같은 자리(같은 y 띠)에 겹쳐 그려져 글자가 뭉친다."""
    order = sorted(range(len(items)), key=lambda i: (items[i][0].y0, items[i][0].x0))
    rects = [fitz.Rect(items[i][0]) for i in order]
    for a in range(len(order)):
        for b in range(a + 1, len(order)):
            ra, rb = rects[a], rects[b]
            if ra.y1 <= rb.y0 or rb.y1 <= ra.y0:
                continue  # 세로로 안 겹침
            ox = min(ra.x1, rb.x1) - max(ra.x0, rb.x0)
            if ox <= 0.30 * min(ra.width, rb.width):
                continue  # 가로로 거의 안 겹침 = 다른 단 → 그대로
            mid = (max(ra.y0, rb.y0) + min(ra.y1, rb.y1)) / 2.0
            top, bot = (ra, rb) if ra.y0 <= rb.y0 else (rb, ra)
            top.y1 = min(top.y1, mid)
            bot.y0 = max(bot.y0, mid)
    out = list(items)
    for k, i in enumerate(order):
        r = rects[k]
        if r.height < 3:
            r.y1 = r.y0 + 3.0
        out[i] = (r,) + tuple(items[i][1:])
    return out


def cmd_render(pdf_path, out_path, font_path):
    payload = json.loads(sys.stdin.read() or "{}")
    translations = payload.get("translations", {}) or {}

    doc = fitz.open(pdf_path)
    build_decoders(doc)  # 추출과 동일한 디코더 — 블록 텍스트/매칭 일관성 유지

    # 페이지별 그림 영역 캐시(추출과 동일 기준) — 축 라벨 줄을 덮기/그리기에서 뺀다.
    fig_cache = {}

    def figs_for(pno):
        if pno not in fig_cache:
            fig_cache[pno] = _skip_regions(doc[pno])  # 그림 + 표
        return fig_cache[pno]

    # 번역이 있는 블록만 (페이지별로) 모은다.
    by_page = defaultdict(list)
    for bid, pno, block in iter_text_blocks(doc):
        ko = translations.get(str(bid))
        if ko is None:
            ko = translations.get(bid)
        if not ko or not str(ko).strip():
            continue
        # 블록 전체 bbox 가 아니라 '그림 영역 줄을 뺀' bbox 만 덮는다.
        # → 캡션에 붙은 축 라벨(V(R_AB))을 지우지 않고 영어 그대로 남긴다.
        rect = _nonfig_rect(block, figs_for(pno))
        size, color, is_bold, is_ital = dominant_size_color(block)
        by_page[pno].append((rect, str(ko).strip(), size, color, is_bold, is_ital))

    # 폰트는 한 번만 로드해 모든 TextWriter 가 공유한다. (insert_htmlbox 는 호출마다
    # 2MB 폰트를 Story 에 재적재해 24쪽/수백 블록에서 ~1.5GB OOM 을 냈다.)
    font = fitz.Font(fontfile=font_path)
    _fdir = os.path.dirname(os.path.abspath(font_path))

    def _load_sibling(name):
        try:
            p = os.path.join(_fdir, name)
            if os.path.exists(p) and os.path.abspath(p) != os.path.abspath(font_path):
                return fitz.Font(fontfile=p)
        except Exception:
            pass
        return None

    # 볼드 글꼴(원문 굵게 → 번역본도 굵게). 없으면 본문 글꼴로 대체(graceful).
    font_bold = _load_sibling("Pretendard-Bold.ttf") or font
    # 폴백 글꼴: 주 글꼴에 없는 글리프(예: ∈)를 가진 블록은 그 블록만 NanumGothic 으로
    # 그려 '두부(□)'를 방지한다.
    font_fb = _load_sibling("NanumGothic-Regular.ttf")

    def _pick_font(text, base):
        """블록 글자를 가장 잘 렌더하는 글꼴 선택(base 우선, 빠진 글리프가 적은 쪽)."""
        if not font_fb:
            return base
        miss_b = sum(
            1 for c in set(text) if ord(c) > 0x7F and not base.has_glyph(ord(c))
        )
        if miss_b == 0:
            return base
        miss_f = sum(
            1 for c in set(text) if ord(c) > 0x7F and not font_fb.has_glyph(ord(c))
        )
        return font_fb if miss_f < miss_b else base

    replaced = 0
    shrunk = 0
    for pno, items in by_page.items():
        page = doc[pno]
        sample = _sample_pixmap(page)  # redaction 색 맞춤용(원본 배경 샘플)
        page_bg = _page_bg(sample)
        figs = figs_for(pno)  # 그림 영역 — 덮기/그리기를 이 밖으로 자른다(캐시 재사용).
        # 블록 rect 를 그림 밖으로 클리핑(완전히 그림 안이면 제외). → 그림 배경에 흰 자국
        # 안 생기고, 캡션에 붙은 축 라벨(V(RAB) 등)도 원본 그대로 유지.
        clipped = []
        for rect, ko, sz, col, bd, it in items:
            cr = _clip_out(rect, figs) if figs else fitz.Rect(rect)
            if cr is None or cr.width < 3 or cr.height < 3:
                continue
            clipped.append((cr, ko, sz, col, bd, it))
        # 원본 블록 bbox 가 위/아래첨자 경계에서 겹쳐 두 번역문이 포개지는 것 방지
        # (redaction 전에 해야 한 블록 redaction 이 다른 블록 글자를 지우지 않음).
        clipped = _dedoverlap_column(clipped)
        # 각 블록의 확장 한계 = 오른쪽/아래 '이웃 블록'까지(없으면 페이지 여백). 제목·헤딩이
        # 번역으로 길어져 가로·세로로 늘어나도 이웃을 침범해 겹치지 않도록 막는다.
        crects = [it[0] for it in clipped]
        nC = len(crects)
        bounds = []
        for i in range(nC):
            ri = crects[i]
            bx = page.rect.x1 - 6.0
            by = page.rect.y1 - 6.0
            for j in range(nC):
                if j == i:
                    continue
                rj = crects[j]
                # 오른쪽 이웃 → 가로 확장 한계. 세로로 조금이라도 같은 띠에 걸치면(0.10)
                # 막는다 — 느슨하면(0.25) 수식 영역의 흩어진 블록이 서로를 못 보고 확장해 겹침.
                oy = min(ri.y1, rj.y1) - max(ri.y0, rj.y0)
                if rj.x0 >= ri.x1 - 1 and oy > 0.10 * min(ri.height, rj.height):
                    bx = min(bx, rj.x0 - 2)
                # 아래 이웃 → 세로 확장 한계(가로로 조금이라도 겹치면 막는다).
                ox = min(ri.x1, rj.x1) - max(ri.x0, rj.x0)
                if rj.y0 >= ri.y1 - 1 and ox > 0.10 * min(ri.width, rj.width):
                    by = min(by, rj.y0 - 2)
            # 세로 확장은 원래 높이의 ~3배까지만(아래 이웃 미검출 시 runaway 방지 — 한
            # 블록이 페이지 절반을 덮어 다른 글자 위로 흐르는 일 차단).
            by = min(by, ri.y1 + 3.0 * max(ri.height, 8.0))
            bounds.append((max(bx, ri.x1), max(by, ri.y1)))
        # 1) 원문 글자만 지운다. images=NONE 으로 그림은 보존.
        #    밝은(흰색 계열) 글자 → fill 생략. 그 외엔 '바로 바깥' 정확 배경색으로 덮어
        #    경계가 안 보이게(상자 느낌 제거).
        for rect, _ko, _sz, _col, _bd, _it in clipped:
            r, g, b = _color01(_col)
            if min(r, g, b) > 0.8:
                fill = None
            else:
                bbg = _bg_around(sample, rect) or page_bg
                fill = (bbg[0] / 255.0, bbg[1] / 255.0, bbg[2] / 255.0)
            page.add_redact_annot(rect, fill=fill)
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
        # 2) 같은(클리핑된) 박스에 번역문 삽입. 본문 양끝맞춤, 제목/한 줄은 가운데/왼쪽.
        page_width = page.rect.width
        for idx, (rect, ko, _size, color, is_bold, is_ital) in enumerate(clipped):
            base = font_bold if is_bold else font  # 원문 굵게 → 번역본도 굵게
            bfont = _pick_font(ko, base)  # 글리프 빠짐 방지(∈ 등은 폴백 글꼴로)
            mx, my = bounds[idx]
            try:
                # 가로로 넓힐 수 있는 최대 폭 기준 '한 줄 여부' 판정(넓혀서 1줄이면 justify
                # 금지 → 단어 벌어짐 방지). 가운데 정렬 블록은 원래 폭 기준.
                avail_w = (
                    rect.width
                    if rect.width >= 0.45 * page_width
                    else (mx - rect.x0)
                )
                one_line = bfont.text_length(ko, fontsize=_size) <= (avail_w - 2)
            except Exception:
                one_line = False
            align = _detect_align(rect, page_width, single_line=one_line)
            if _draw_fit(
                page,
                rect,
                ko,
                _color01(color),
                bfont,
                _size,
                align,
                italic=is_ital,
                max_x=mx,
                max_y=my,
            ):
                shrunk += 1
            replaced += 1

    doc.save(out_path, garbage=3, deflate=True)
    doc.close()
    sys.stdout.write(json.dumps({"ok": True, "replaced": replaced, "shrunk": shrunk}))


def cmd_split(pdf_path, out_dir, pages_per_chunk=5):
    """텍스트 PDF 를 페이지 범위로 나눠 sub-PDF 들로 저장(재조판 병렬 처리용).
    각 chunk 를 동시에 번역해 합치면 Opus 품질 그대로 벽시계 시간을 줄인다."""
    pages_per_chunk = max(1, int(pages_per_chunk))
    os.makedirs(out_dir, exist_ok=True)
    src = fitz.open(pdf_path)
    n = len(src)
    chunks = []
    ci = 0
    for start in range(0, n, pages_per_chunk):
        end = min(start + pages_per_chunk, n)
        sub = fitz.open()
        sub.insert_pdf(src, from_page=start, to_page=end - 1)
        path = os.path.join(out_dir, f"chunk-{ci}.pdf")
        sub.save(path, garbage=3, deflate=True)
        sub.close()
        chunks.append({"path": path, "start": start + 1, "end": end})
        ci += 1
    src.close()
    sys.stdout.write(
        json.dumps({"page_count": n, "chunks": chunks}, ensure_ascii=False)
    )


def _figure_caption(tblocks, reg, gap=80.0):
    """그림 영역 reg 의 캡션(마커 배치 힌트). 'FIGURE/그림/Table/표/Scheme …'으로
    시작하는, 그림과 가까운(세로로 겹치거나 위/아래 ±gap) 블록만 신뢰한다. 옆에
    붙은 캡션도 잡고, 본문 문단·저작권 푸터를 캡션으로 오인하지 않는다."""
    import re as _re

    # 키워드(FIGURE/그림/Table…) + 번호. 블록 앞부분에서만 찾아 본문 중간의
    # 'see Figure 6' 같은 참조는 캡션으로 오인하지 않는다.
    pat = _re.compile(
        r"(FIG(?:URE)?|그림|Figure|Table|TABLE|표|SCHEME|Scheme)\.?\s*[\dIVXP]",
        _re.I,
    )
    cx_r, cy_r = (reg.x0 + reg.x1) / 2.0, (reg.y0 + reg.y1) / 2.0
    cands = []
    for b in tblocks:
        if len(b) < 5:
            continue
        x0, y0, x1, y1 = b[0], b[1], b[2], b[3]
        txt = (b[4] or "").strip()
        if not txt:
            continue
        oneline = " ".join(txt.split())
        m = pat.search(oneline[:40])  # 캡션은 앞쪽에서 시작
        if not m:
            continue
        if y1 < reg.y0 - gap or y0 > reg.y1 + gap:
            continue  # 그림에서 세로로 너무 멀면 다른 그림 캡션
        cap = oneline[m.start() :]  # 키워드부터(앞에 붙은 축 라벨 등 제거)
        dist = abs((x0 + x1) / 2.0 - cx_r) + abs((y0 + y1) / 2.0 - cy_r)
        cands.append((dist, cap))
    if cands:
        cands.sort(key=lambda t: t[0])
        return cands[0][1][:90]
    return ""


def cmd_figures(pdf_path, out_dir, zoom=3.0):
    """텍스트 PDF 의 그림/도표 영역을 PNG 로 잘라 out_dir 에 저장하고 메타데이터를 낸다.
    재조판(re-typeset) 시 원본 그림을 \\includegraphics 로 복원하기 위한 입력.
    번호는 페이지 순·세로 위→아래 순으로 매겨 Claude 마커 순서와 맞춘다."""
    try:
        zoom = float(zoom)
    except Exception:
        zoom = 3.0
    zoom = max(1.5, min(5.0, zoom))
    doc = fitz.open(pdf_path)
    os.makedirs(out_dir, exist_ok=True)
    figs_out = []
    n = 0
    for pno in range(len(doc)):
        page = doc[pno]
        regs = _figure_regions(page)
        if not regs:
            continue
        regs = sorted(regs, key=lambda r: (round(r.y0, 1), round(r.x0, 1)))
        try:
            tblocks = page.get_text("blocks")
        except Exception:
            tblocks = []
        mat = fitz.Matrix(zoom, zoom)
        pr = page.rect
        for reg in regs:
            if reg.width < 45 or reg.height < 45:
                continue  # 너무 작음(아이콘·기호 조각) → 그림으로 보지 않음
            # 축 라벨·화살촉이 잘리지 않게 약간 여백을 주되, 페이지 밖으로 안 나가게.
            pad = 7.0
            rr = fitz.Rect(
                max(pr.x0, reg.x0 - pad),
                max(pr.y0, reg.y0 - pad),
                min(pr.x1, reg.x1 + pad),
                min(pr.y1, reg.y1 + pad),
            )
            try:
                pix = page.get_pixmap(matrix=mat, clip=rr, alpha=False)
            except Exception:
                continue
            if pix.width < 12 or pix.height < 12:
                continue
            n += 1
            fname = os.path.join(out_dir, f"fig-{n}.png")
            try:
                pix.save(fname)
            except Exception:
                n -= 1
                continue
            figs_out.append(
                {
                    "n": n,
                    "page": pno + 1,
                    "bbox": [
                        round(reg.x0, 1),
                        round(reg.y0, 1),
                        round(reg.x1, 1),
                        round(reg.y1, 1),
                    ],
                    "caption": _figure_caption(tblocks, reg),
                    "file": os.path.abspath(fname),
                    "w": pix.width,
                    "h": pix.height,
                }
            )
    sys.stdout.write(
        json.dumps({"page_count": len(doc), "figures": figs_out}, ensure_ascii=False)
    )
    doc.close()


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: translate_pdf.py extract|render ...\n")
        sys.exit(2)
    mode = sys.argv[1]
    try:
        if mode == "extract":
            cmd_extract(sys.argv[2])
        elif mode == "analyze":
            cmd_analyze(sys.argv[2])
        elif mode == "rasterize":
            # rasterize <pdf> <out_dir> [long_edge_px] [max_pages]
            cmd_rasterize(*sys.argv[2:6])
        elif mode == "render":
            cmd_render(sys.argv[2], sys.argv[3], sys.argv[4])
        elif mode == "split":
            # split <pdf> <out_dir> [pages_per_chunk]
            cmd_split(*sys.argv[2:5])
        elif mode == "figures":
            # figures <pdf> <out_dir> [zoom] — 재조판 그림 복원용 크롭 추출
            cmd_figures(*sys.argv[2:5])
        else:
            sys.stderr.write(f"unknown mode: {mode}\n")
            sys.exit(2)
    except Exception as e:  # noqa: BLE001 — Node 에 stderr 로 원인 전달
        sys.stderr.write(f"{type(e).__name__}: {e}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
