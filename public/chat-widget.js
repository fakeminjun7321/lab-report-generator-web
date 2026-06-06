/* Quilo AI 도우미 위젯 — 사용법 도움 + 메모 작성 도우미(무거운 모델) + 답변 액션바.
   서버에 CHAT_API_KEY가 없으면(/api/chat/status enabled=false) 위젯/버튼을 표시하지 않는다. */
(function () {
  "use strict";
  window.Quilo = window.Quilo || {};
  if (window.__quiloChatLoaded) return;
  window.__quiloChatLoaded = true;

  var HELP_GREETING =
    "안녕하세요! Quilo 사용을 도와드리는 AI예요. 보고서 작성·기능·크레딧 등 궁금한 걸 물어보세요.";
  var HELP_SUGGESTIONS = [
    "사전보고서랑 결과보고서 차이가 뭐야?",
    "HWPX 파일이 안 열려요",
    "크레딧은 어떻게 충전해요?",
  ];
  var MEMO_GREETING =
    "실험 내용을 알려주시면 보고서에 넣을 'AI 참고 메모' 초안을 만들어드려요. 무엇을 측정했고, 어떤 결과·경향이었나요? 특이사항이 있었나요?";
  var MEMO_SUGGESTIONS = [
    "오늘 한 실험을 설명할게",
    "측정값이 이론값과 달랐어",
    "실험 중 특이사항이 있었어",
  ];

  var messages = [];
  var busy = false;
  var openedOnce = false;
  var currentMode = "help"; // 'help' | 'memo'
  var memoTarget = null; // 메모를 넣을 textarea id (폼에서 열었을 때)
  var panel, msgsEl, chipsEl, inputEl, sendBtn;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function pageContext() {
    try {
      return (document.title || "Quilo") + " (" + location.pathname + ")";
    } catch (e) {
      return "";
    }
  }
  function save() {
    try {
      sessionStorage.setItem(
        "quiloChat",
        JSON.stringify({ m: messages, mode: currentMode })
      );
    } catch (e) {}
  }
  function load() {
    try {
      var s = JSON.parse(sessionStorage.getItem("quiloChat") || "null");
      if (s && Array.isArray(s.m)) {
        messages = s.m;
        if (s.mode === "memo" || s.mode === "help") currentMode = s.mode;
        return true;
      }
    } catch (e) {}
    return false;
  }
  function restoreConversation() {
    msgsEl.innerHTML = "";
    chipsEl.style.display = "none";
    var _mb = document.getElementById("qc-modebar");
    if (_mb) _mb.style.display = currentMode === "memo" ? "flex" : "none";
    var isMemo = currentMode === "memo";
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.role === "user") {
        addUserRow(m.content);
      } else {
        var ai = addAiRow();
        ai.bubble.textContent = m.content;
        attachBar(
          ai.row,
          messages.slice(0, i),
          (messages[i - 1] || {}).content || "",
          m.content,
          false,
          isMemo
        );
      }
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function injectStyles() {
    var css =
      "#qc-launch{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;background:#243ba2;color:#fff;border:none;cursor:pointer;box-shadow:0 8px 24px rgba(36,59,162,.35);font-size:24px;z-index:2147483000;display:flex;align-items:center;justify-content:center;transition:transform .08s}" +
      "#qc-launch:hover{transform:translateY(-2px)}" +
      "#qc-panel{position:fixed;right:20px;bottom:88px;width:360px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);background:#fff;border:1px solid #e6e8f0;border-radius:16px;z-index:2147483000;display:none;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(15,23,42,.22);font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Pretendard','Segoe UI',system-ui,sans-serif}" +
      "#qc-panel.open{display:flex}" +
      "#qc-head{background:#243ba2;color:#fff;padding:13px 16px;display:flex;align-items:center;gap:8px}" +
      "#qc-head b{font-size:15px}#qc-head .qc-sub{font-size:11px;opacity:.8;margin-left:auto;margin-right:8px}" +
      "#qc-close{background:transparent;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;padding:0 2px}" +
      "#qc-modebar{display:none;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;background:#eef1fc;border-bottom:1px solid #dfe4fb;font-size:12.5px;color:#243ba2;font-weight:600}" +
      "#qc-modebar button{background:#fff;border:1px solid #c9d2f7;color:#243ba2;border-radius:7px;font-size:11.5px;padding:3px 9px;cursor:pointer;font-family:inherit;font-weight:500}" +
      "#qc-modebar button:hover{background:#e4e9fc}" +
      "#qc-msgs{flex:1;overflow-y:auto;padding:14px;background:#f6f7fb;display:flex;flex-direction:column;gap:10px}" +
      ".qc-row{display:flex}.qc-row.me{justify-content:flex-end}.qc-row.ai{flex-direction:column;align-items:flex-start}" +
      ".qc-b{max-width:84%;padding:9px 12px;border-radius:13px;font-size:13.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}" +
      ".qc-row.ai .qc-b{background:#fff;border:1px solid #e6e8f0;color:#0f172a;border-bottom-left-radius:4px}" +
      ".qc-row.me .qc-b{background:#243ba2;color:#fff;border-bottom-right-radius:4px}" +
      ".qc-b.err{background:#fff4f4;border-color:#f3c0c0;color:#9b2c2c}" +
      ".qc-bar{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:5px}" +
      ".qc-bar button{background:transparent;border:1px solid #e6e8f0;border-radius:8px;font-size:11.5px;color:#64748b;padding:3px 8px;cursor:pointer;line-height:1.4;font-family:inherit}" +
      ".qc-bar button:hover{background:#f1f3f9;color:#334155}.qc-bar button.on{background:#eef1fc;border-color:#c9d2f7;color:#243ba2}" +
      ".qc-bar button.prim{border-color:#c9d2f7;color:#243ba2}" +
      ".qc-fb{display:none;flex-direction:column;gap:6px;margin-top:6px;width:84%}.qc-fb.open{display:flex}" +
      ".qc-fb textarea{border:1px solid #d7dbe8;border-radius:8px;padding:7px 9px;font:inherit;font-size:12.5px;resize:none;outline:none}" +
      ".qc-fb .frow{display:flex;gap:6px;justify-content:flex-end}" +
      ".qc-fb .frow button{font-size:12px;border-radius:7px;padding:4px 11px;cursor:pointer;border:1px solid #e6e8f0;background:#fff;font-family:inherit}" +
      ".qc-fb .frow .send{background:#243ba2;color:#fff;border-color:#243ba2}" +
      ".qc-note{font-size:11px;color:#16a34a;margin-top:4px}" +
      "#qc-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px;background:#f6f7fb}" +
      ".qc-chip{font-size:12px;color:#243ba2;background:#eef1fc;border:1px solid #dfe4fb;border-radius:999px;padding:6px 10px;cursor:pointer;font-family:inherit}.qc-chip:hover{background:#e4e9fc}" +
      "#qc-foot{border-top:1px solid #eef0f6;padding:8px;background:#fff}" +
      "#qc-inrow{display:flex;gap:8px;align-items:flex-end}" +
      "#qc-in{flex:1;resize:none;border:1px solid #d7dbe8;border-radius:10px;padding:9px 11px;font:inherit;font-size:13.5px;max-height:96px;outline:none}#qc-in:focus{border-color:#243ba2}" +
      "#qc-send{flex:0 0 auto;background:#243ba2;color:#fff;border:none;border-radius:10px;padding:0 14px;height:38px;cursor:pointer;font-weight:600;font-size:13px}#qc-send:disabled{background:#aab2d6;cursor:default}" +
      "#qc-disc{font-size:10.5px;color:#94a3b8;text-align:center;margin-top:6px}";
    var s = el("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  function addUserRow(text) {
    var row = el("div", "qc-row me");
    row.appendChild(el("div", "qc-b", text));
    msgsEl.appendChild(row);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return row;
  }
  function addAiRow() {
    var row = el("div", "qc-row ai");
    var b = el("div", "qc-b");
    row.appendChild(b);
    msgsEl.appendChild(row);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return { row: row, bubble: b };
  }

  function sendFeedback(p) {
    p.pageUrl = location.href;
    fetch("/api/chat/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    }).catch(function () {});
  }

  function extractMemo(t) {
    t = t || "";
    var i = t.indexOf("메모 초안");
    if (i >= 0) {
      var rest = t.slice(i).replace(/^메모\s*초안\s*[:：]?\s*/, "");
      return rest.trim() || t.trim();
    }
    return t.trim();
  }

  function attachBar(row, snapshot, question, answer, isError, isMemo) {
    var bar = el("div", "qc-bar");
    if (!isError) {
      if (isMemo) {
        var copy = el("button", "prim", "📋 복사");
        copy.onclick = function () {
          try {
            navigator.clipboard.writeText(extractMemo(answer));
            copy.textContent = "복사됨!";
            setTimeout(function () {
              copy.textContent = "📋 복사";
            }, 1200);
          } catch (e) {}
        };
        bar.appendChild(copy);
        if (memoTarget) {
          var ins = el("button", "prim", "↧ 메모칸에 넣기");
          ins.onclick = function () {
            var ta = document.getElementById(memoTarget);
            if (ta) {
              ta.value = extractMemo(answer);
              ta.dispatchEvent(new Event("input", { bubbles: true }));
              row.appendChild(el("div", "qc-note", "메모칸에 넣었어요 ✓"));
            }
          };
          bar.appendChild(ins);
        }
      } else {
        var up = el("button", null, "👍");
        var down = el("button", null, "👎");
        up.title = "도움이 됐어요";
        down.title = "별로예요";
        up.onclick = function () {
          up.classList.add("on");
          down.classList.remove("on");
          sendFeedback({ rating: "up", question: question, answer: answer });
        };
        down.onclick = function () {
          down.classList.add("on");
          up.classList.remove("on");
          sendFeedback({ rating: "down", question: question, answer: answer });
        };
        bar.appendChild(up);
        bar.appendChild(down);
      }
    }
    var regen = el("button", null, "↻ 다시 시도");
    regen.onclick = function () {
      if (busy) return;
      regenerate(row, snapshot);
    };
    bar.appendChild(regen);

    if (!isError) {
      var opin = el("button", null, "✎ 의견");
      bar.appendChild(opin);
      row.appendChild(bar);
      var fb = el("div", "qc-fb");
      var ta2 = el("textarea");
      ta2.rows = 2;
      ta2.placeholder = "버그·개선 의견을 적어주세요";
      var frow = el("div", "frow");
      var cancel = el("button", null, "취소");
      var sendb = el("button", "send", "보내기");
      cancel.onclick = function () {
        fb.classList.remove("open");
      };
      sendb.onclick = function () {
        var c = (ta2.value || "").trim();
        if (!c) return;
        sendFeedback({
          rating: "comment",
          comment: c,
          question: question,
          answer: answer,
        });
        fb.classList.remove("open");
        opin.style.display = "none";
        row.appendChild(el("div", "qc-note", "의견 보냈어요. 고마워요! 🙏"));
      };
      opin.onclick = function () {
        fb.classList.toggle("open");
        if (fb.classList.contains("open")) ta2.focus();
      };
      frow.appendChild(cancel);
      frow.appendChild(sendb);
      fb.appendChild(ta2);
      fb.appendChild(frow);
      row.appendChild(fb);
    } else {
      row.appendChild(bar);
    }
  }

  function regenerate(row, snapshot) {
    messages = snapshot.slice();
    var n = row;
    var rm = [];
    while (n) {
      rm.push(n);
      n = n.nextElementSibling;
    }
    rm.forEach(function (x) {
      x.remove();
    });
    streamAssistant();
  }

  function streamAssistant() {
    busy = true;
    if (sendBtn) sendBtn.disabled = true;
    var snapshot = messages.slice();
    var question = (snapshot[snapshot.length - 1] || {}).content || "";
    var isMemo = currentMode === "memo";
    var ai = addAiRow();
    ai.bubble.textContent = "…";

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: snapshot.slice(-8),
        mode: currentMode,
        context: pageContext(),
      }),
    })
      .then(function (resp) {
        if (!resp.ok || !resp.body) {
          return resp
            .json()
            .catch(function () {
              return {};
            })
            .then(function (j) {
              throw new Error(j.error || "오류가 발생했어요. 잠시 후 다시 시도하세요.");
            });
        }
        var reader = resp.body.getReader();
        var dec = new TextDecoder();
        var acc = "";
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return acc;
            acc += dec.decode(r.value, { stream: true });
            ai.bubble.textContent = acc;
            msgsEl.scrollTop = msgsEl.scrollHeight;
            return pump();
          });
        }
        return pump();
      })
      .then(function (acc) {
        if (!acc || !acc.trim()) {
          ai.bubble.textContent = "(응답이 없습니다. 다시 시도해 주세요.)";
          attachBar(ai.row, snapshot, question, "", true, isMemo);
        } else {
          messages.push({ role: "assistant", content: acc });
          attachBar(ai.row, snapshot, question, acc, false, isMemo);
          save();
        }
      })
      .catch(function (e) {
        ai.bubble.classList.add("err");
        ai.bubble.textContent = e.message || "오류가 발생했어요.";
        attachBar(ai.row, snapshot, question, "", true, isMemo);
      })
      .then(function () {
        busy = false;
        if (sendBtn) sendBtn.disabled = false;
        if (inputEl) inputEl.focus();
        msgsEl.scrollTop = msgsEl.scrollHeight;
      });
  }

  function send(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    if (chipsEl) chipsEl.style.display = "none";
    addUserRow(text);
    messages.push({ role: "user", content: text });
    save();
    inputEl.value = "";
    inputEl.style.height = "auto";
    streamAssistant();
  }

  function renderChips(list) {
    chipsEl.innerHTML = "";
    list.forEach(function (q) {
      var c = el("button", "qc-chip", q);
      c.onclick = function () {
        send(q);
      };
      chipsEl.appendChild(c);
    });
    chipsEl.style.display = "flex";
  }

  function showIntro() {
    msgsEl.innerHTML = "";
    addAiRow().bubble.textContent =
      currentMode === "memo" ? MEMO_GREETING : HELP_GREETING;
    renderChips(currentMode === "memo" ? MEMO_SUGGESTIONS : HELP_SUGGESTIONS);
  }

  function setMode(mode) {
    if (busy) return;
    currentMode = mode;
    if (mode === "help") memoTarget = null;
    var _mb = document.getElementById("qc-modebar");
    if (_mb) _mb.style.display = mode === "memo" ? "flex" : "none";
    messages = [];
    showIntro();
    save();
  }

  function buildPanel() {
    panel = el("div");
    panel.id = "qc-panel";

    var head = el("div");
    head.id = "qc-head";
    head.appendChild(el("b", null, "Quilo 도우미"));
    head.appendChild(el("span", "qc-sub", "AI"));
    var close = el("button", null, "×");
    close.id = "qc-close";
    close.setAttribute("aria-label", "닫기");
    close.onclick = toggle;
    head.appendChild(close);
    panel.appendChild(head);

    // 상시 토글 없음. 메모 모드일 때만 보이는 안내 바(일반 도움말로 돌아가기 포함).
    var modebar = el("div");
    modebar.id = "qc-modebar";
    modebar.appendChild(el("span", null, "📝 메모 작성 도우미"));
    var mback = el("button", null, "일반 도움말 ✕");
    mback.onclick = function () {
      setMode("help");
    };
    modebar.appendChild(mback);
    panel.appendChild(modebar);

    msgsEl = el("div");
    msgsEl.id = "qc-msgs";
    panel.appendChild(msgsEl);

    chipsEl = el("div");
    chipsEl.id = "qc-chips";
    panel.appendChild(chipsEl);

    var foot = el("div");
    foot.id = "qc-foot";
    var inrow = el("div");
    inrow.id = "qc-inrow";
    inputEl = el("textarea");
    inputEl.id = "qc-in";
    inputEl.rows = 1;
    inputEl.placeholder = "메시지를 입력하세요…";
    inputEl.addEventListener("input", function () {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 96) + "px";
    });
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send(inputEl.value);
      }
    });
    sendBtn = el("button", null, "전송");
    sendBtn.id = "qc-send";
    sendBtn.onclick = function () {
      send(inputEl.value);
    };
    inrow.appendChild(inputEl);
    inrow.appendChild(sendBtn);
    foot.appendChild(inrow);
    var disc = el(
      "div",
      null,
      "AI 도우미 · 부정확할 수 있어요. 중요한 건 직접 확인하세요."
    );
    disc.id = "qc-disc";
    foot.appendChild(disc);
    panel.appendChild(foot);

    document.body.appendChild(panel);
  }

  function toggle() {
    var opening = !panel.classList.contains("open");
    panel.classList.toggle("open");
    if (opening && !openedOnce) {
      openedOnce = true;
      if (messages.length) restoreConversation();
      else showIntro();
    }
    if (opening) setTimeout(function () { inputEl.focus(); }, 50);
  }

  function init() {
    injectStyles();
    var launch = el("button", null, "💬");
    launch.id = "qc-launch";
    launch.setAttribute("aria-label", "Quilo 도우미 열기");
    launch.onclick = toggle;
    document.body.appendChild(launch);
    buildPanel();
    load();
    // 폼에 있는 'AI 메모 작성 도움' 버튼들을 노출 (챗이 켜졌을 때만)
    var btns = document.querySelectorAll(".qc-memo-btn");
    for (var i = 0; i < btns.length; i++) btns[i].style.display = "";
  }

  // 폼(보고서 입력칸)에서 호출: 메모 모드로 패널 열기
  window.Quilo.openMemo = function (targetId) {
    if (!panel) return; // 챗이 꺼져 있으면 무시
    memoTarget = targetId || null;
    openedOnce = true;
    panel.classList.add("open");
    setMode("memo");
    setTimeout(function () {
      if (inputEl) inputEl.focus();
    }, 60);
  };

  fetch("/api/chat/status")
    .then(function (r) {
      return r.json();
    })
    .then(function (j) {
      if (j && j.enabled) {
        if (document.readyState === "loading")
          document.addEventListener("DOMContentLoaded", init);
        else init();
      }
    })
    .catch(function () {});
})();
