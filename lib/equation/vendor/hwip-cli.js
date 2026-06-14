#!/usr/bin/env node
/*
 * LaTeX → 한컴(HWP) 수식 script 일괄 변환 CLI (hwip 엔진 래퍼).
 *   stdin : JSON {"latex": ["\\frac{a}{b}", ...]}
 *   stdout: JSON {"scripts": ["{a} over {b}", ... | null]}  (변환 실패한 항목은 null)
 *
 * hwip(converter.js)은 다중문자 첨자 I_{pivot} 를 I _{p i v o t} 로 글자 단위로 쪼갠다.
 * 그대로 두면 hwpx_equation_tool.normalize 의 quote_textual_subscripts 가 _{"p i v o t"}
 * (공백 포함)로 만들어 더 나빠진다. 그래서 여기서 _{단일문자들} 을 _{"pivot"} 로 재결합한다.
 *
 * 변환 엔진 출처: latex-to-hwp by Shin Mingyu(@minigu5) — vendor/NOTICE 참조.
 */
"use strict";
const path = require("path");

let convert;
try {
  const mod = require(path.join(__dirname, "hwip-converter.js"));
  convert = mod && (mod.convert || (mod.default && mod.default.convert));
} catch (e) {
  convert = null;
}

// _{p i v o t} / ^{e l} 처럼 공백으로 쪼개진 단일문자 라벨을 재결합.
//  - 글자가 섞이면 텍스트 라벨 _{"pivot"} (한컴에서 위첨자 'pi' 가 π 로 오해되는 것 방지)
//  - 전부 숫자면 _{12}
//  - hwip 은 LaTeX 원문의 'x _{n}' 공백을 '_ {…}' 로 보존하므로 _/^ 와 { 사이
//    공백을 허용해야 한다(놓치면 뒤 단계 인용이 _{"m a x"} 로 굳는다).
function rejoinLabels(script) {
  return String(script).replace(/([_^])\s*\{([^{}]+)\}/g, (m, op, body) => {
    const toks = body.trim().split(/\s+/);
    if (toks.length >= 2 && toks.every((t) => /^[A-Za-z0-9]$/.test(t))) {
      const joined = toks.join("");
      return /[A-Za-z]/.test(joined) ? `${op}{"${joined}"}` : `${op}{${joined}}`;
    }
    return m;
  });
}

function one(tex) {
  if (!convert) return null;
  try {
    const t = String(tex == null ? "" : tex).trim();
    if (!t) return null;
    // hwip 은 $..$ / $$..$$ 구분자를 벗긴다. raw LaTeX 면 $ 로 감싸 통일.
    const wrapped = /^\$|\$$/.test(t) ? t : "$" + t + "$";
    const script = convert(wrapped);
    if (!script || !String(script).trim()) return null;
    return rejoinLabels(String(script).trim());
  } catch (e) {
    return null;
  }
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let list = [];
  try {
    list = JSON.parse(raw).latex || [];
  } catch (e) {
    list = [];
  }
  const scripts = list.map(one);
  process.stdout.write(JSON.stringify({ scripts }));
});
