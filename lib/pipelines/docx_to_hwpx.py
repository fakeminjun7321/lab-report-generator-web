#!/usr/bin/env python3
"""DOCX → HWPX 변환(수식 보존).

pypandoc-hwpx 는 Pandoc AST 의 수식(Math) 노드를 그냥 버려 수식이 사라진다.
이 드라이버는 기존 프로젝트 코드만으로 그 문제를 해결한다:

  1) pandoc 으로 docx → Pandoc JSON AST.
  2) AST 의 Math 노드를 `{{EQ-LATEX:<latex>}}` 마커 텍스트로 치환.
  3) pypandoc-hwpx(AST → HWPX): 마커가 본문 텍스트로 그대로 들어간다.
  4) lib/equation/hwpx_equation_tool.py 로 마커를 한컴 수식 객체(hp:equation)로 치환.

usage: docx_to_hwpx.py <in.docx> <out.hwpx>
"""
import sys
import os
import json
import shutil
import subprocess
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EQ_TOOL = os.path.join(ROOT, "lib", "equation", "hwpx_equation_tool.py")


def _math_to_markers(node):
    """Pandoc AST 를 순회하며 Math 노드를 {{EQ-LATEX:...}} 마커 Str 로 바꾼다."""
    if isinstance(node, dict):
        if node.get("t") == "Math":
            c = node.get("c")
            tex = c[1] if isinstance(c, list) and len(c) > 1 else ""
            return {"t": "Str", "c": "{{EQ-LATEX:" + str(tex) + "}}"}
        return {k: _math_to_markers(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_math_to_markers(v) for v in node]
    return node


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: docx_to_hwpx.py <in.docx> <out.hwpx>\n")
        return 2
    in_docx, out_hwpx = sys.argv[1], sys.argv[2]
    py = sys.executable
    pandoc = os.environ.get("PYPANDOC_PANDOC") or "pandoc"

    with tempfile.TemporaryDirectory() as td:
        # 1) docx → AST
        ast_bytes = subprocess.check_output([pandoc, in_docx, "-t", "json"])
        ast = json.loads(ast_bytes)
        # 2) Math → 마커
        ast = _math_to_markers(ast)
        mod = os.path.join(td, "mod.json")
        with open(mod, "w", encoding="utf-8") as f:
            json.dump(ast, f, ensure_ascii=False)
        # 3) AST(.json) → HWPX (마커 텍스트 포함). pypandoc-hwpx 가 .json 입력을 처리.
        marked = os.path.join(td, "marked.hwpx")
        subprocess.check_call([py, "-m", "pypandoc_hwpx.cli", mod, "-o", marked])
        # 4) 마커가 있으면 한컴 수식 객체로 치환. 없으면 그대로.
        #    마커는 zip 내부 section XML 에 (압축되어) 있으므로 zip 안을 읽어 확인한다.
        has_marker = False
        try:
            import zipfile

            with zipfile.ZipFile(marked) as z:
                for n in z.namelist():
                    if "section" in n and n.endswith(".xml") and b"EQ-LATEX" in z.read(n):
                        has_marker = True
                        break
        except Exception:
            has_marker = True  # 불확실하면 변환을 시도(안전)
        if has_marker:
            r = subprocess.run([py, EQ_TOOL, "replace", marked, out_hwpx])
            # 수식 치환이 실패해도 문서 자체는 살린다(마커가 LaTeX 텍스트로 보임).
            if r.returncode != 0 or not os.path.exists(out_hwpx):
                shutil.copy(marked, out_hwpx)
        else:
            shutil.copy(marked, out_hwpx)
    return 0


if __name__ == "__main__":
    sys.exit(main())
