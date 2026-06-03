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


def block_text(block):
    """블록 안의 줄들을 사람이 읽을 한 문단 문자열로 합친다.

    화면상 줄바꿈(wrap)은 공백으로 이어 붙인다 — 한 문장이 여러 줄에 걸쳐도
    번역은 한 단위로 처리해야 자연스럽기 때문이다.
    """
    lines = []
    for ln in block.get("lines", []):
        s = "".join(sp.get("text", "") for sp in ln.get("spans", []))
        if s.strip():
            lines.append(s.strip())
    return " ".join(lines).strip()


def dominant_size_color(block):
    """글자 수 기준으로 가장 많이 쓰인 폰트 크기와 색을 고른다.

    본문은 보통 단일 크기/색이고, 제목 블록은 그 블록의 크기를 따른다.
    """
    sizes = defaultdict(float)
    colors = defaultdict(float)
    for ln in block.get("lines", []):
        for sp in ln.get("spans", []):
            n = max(1, len(sp.get("text", "")))
            sizes[round(float(sp.get("size", 10.0)), 1)] += n
            colors[int(sp.get("color", 0))] += n
    size = max(sizes, key=sizes.get) if sizes else 10.0
    color = max(colors, key=colors.get) if colors else 0
    return size, color


def has_letters(s):
    """알파벳/한글 등 '글자'가 하나라도 있는지. 순수 숫자·기호 블록은 번역 제외."""
    return any(ch.isalpha() for ch in s)


def cmd_extract(pdf_path):
    doc = fitz.open(pdf_path)
    blocks = []
    total_text_chars = 0
    for bid, pno, block in iter_text_blocks(doc):
        text = block_text(block)
        if not text or not has_letters(text):
            continue
        total_text_chars += len(text)
        blocks.append({"id": bid, "page": pno, "text": text})
    # 텍스트가 거의 없으면 스캔본(글자가 이미지)일 가능성이 높다 → Node가 안내.
    scanned = len(doc) > 0 and total_text_chars < 20 * len(doc)
    out = {"page_count": len(doc), "scanned": scanned, "blocks": blocks}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    doc.close()


_MATH_SYMS = "∑∫√±×÷≤≥≠≈∞∂∇·°→←↔⟨⟩∝∈∉⊂⊃∪∩∀∃∮∇µΩ"


def cmd_analyze(pdf_path):
    """텍스트 레이어 유무 + 수식 밀도를 판정(자동 변환방식 선택용).
    scanned: 텍스트 레이어 없음(스캔/이미지). math_density: 1000자당 수식 지표 점수."""
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


def _detect_align(rect, page_width):
    """원문 블록 위치로 정렬을 추정한다.

    제목/저자처럼 '좁고 + 좌우 여백이 거의 대칭'인 블록은 가운데 정렬,
    그 외(본문 컬럼)는 양끝맞춤(justify) — LaTeX 조판처럼 단정해진다.
    본문은 컬럼 폭을 거의 다 쓰므로 폭 기준으로 제목과 구분된다.
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


def _draw_fit(page, rect, text, color, font, start_size, align, min_size=4.0):
    """rect 안에 다 들어가도록 폰트 크기를 줄여가며 '한 번만' 그린다.

    insert_textbox 는 줄높이를 직접 추정해야 해서, 높이가 한 줄과 비슷한 얇은
    박스(예: 제목)에서 '맞다고 계산했지만 실제로는 한 줄도 안 들어가 아무것도
    안 그려지는' 문제가 있었다(제목이 통째로 사라진 버그). TextWriter 는
    write_text() 전에는 페이지에 그리지 않으므로, fill_textbox 로 '다 들어갔는지'를
    먼저 확인하고 들어갈 때만 커밋한다 → 겹침·잘림·증발이 없다.

    align: 본문은 justify(양끝맞춤), 제목류는 center — fill_textbox 는 마지막 줄
    /한 줄짜리는 자동으로 좌측 처리하므로 짧은 블록도 어색하지 않다.
    """
    fs = max(min_size, min(float(start_size), 400.0))
    while fs > min_size:
        tw = fitz.TextWriter(page.rect)
        leftover = tw.fill_textbox(rect, text, font=font, fontsize=fs, align=align)
        if not _has_leftover(leftover):
            tw.write_text(page, color=color)
            return fs < float(start_size) - 0.01
        fs -= 0.5
    # 최소 크기에서도 넘치면 들어가는 만큼이라도 그린다(빈칸보다 낫다).
    tw = fitz.TextWriter(page.rect)
    tw.fill_textbox(rect, text, font=font, fontsize=min_size, align=align)
    tw.write_text(page, color=color)
    return True


def cmd_render(pdf_path, out_path, font_path):
    payload = json.loads(sys.stdin.read() or "{}")
    translations = payload.get("translations", {}) or {}

    doc = fitz.open(pdf_path)

    # 번역이 있는 블록만 (페이지별로) 모은다.
    by_page = defaultdict(list)
    for bid, pno, block in iter_text_blocks(doc):
        ko = translations.get(str(bid))
        if ko is None:
            ko = translations.get(bid)
        if not ko or not str(ko).strip():
            continue
        rect = fitz.Rect(block["bbox"])
        size, color = dominant_size_color(block)
        by_page[pno].append((rect, str(ko).strip(), size, color))

    # 폰트는 한 번만 로드해 모든 TextWriter 가 공유한다. (insert_htmlbox 는 호출마다
    # 2MB 폰트를 Story 에 재적재해 24쪽/수백 블록에서 ~1.5GB OOM 을 냈다.)
    font = fitz.Font(fontfile=font_path)

    replaced = 0
    shrunk = 0
    for pno, items in by_page.items():
        page = doc[pno]
        # 1) 원문 글자만 지운다. images=NONE 으로 그림은 보존.
        #    밝은(흰색 계열) 글자는 어두운 배경 위에 있을 가능성이 높다 → 흰색으로
        #    덮으면 배경까지 흰 박스가 되고 다시 그린 흰 글자도 안 보인다. 이 경우엔
        #    fill 을 생략해 원래 배경(그림/도형)이 비치게 한다.
        for rect, _ko, _sz, _col in items:
            r, g, b = _color01(_col)
            light = min(r, g, b) > 0.8
            page.add_redact_annot(rect, fill=None if light else (1, 1, 1))
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
        # 2) 같은 박스에 번역문 삽입(넘치면 폰트를 줄여 맞춤). TextWriter 가 폰트 임베드.
        #    본문은 양끝맞춤, 제목류는 가운데 정렬로 LaTeX 조판처럼 단정하게.
        page_width = page.rect.width
        for rect, ko, _size, color in items:
            align = _detect_align(rect, page_width)
            if _draw_fit(page, rect, ko, _color01(color), font, _size, align):
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
        else:
            sys.stderr.write(f"unknown mode: {mode}\n")
            sys.exit(2)
    except Exception as e:  # noqa: BLE001 — Node 에 stderr 로 원인 전달
        sys.stderr.write(f"{type(e).__name__}: {e}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
