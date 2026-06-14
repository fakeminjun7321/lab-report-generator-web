/* Quilo frontend app. Extracted from index.html; keep server form field contracts stable. */
let currentStudentId = "";
      const USE_POLICY_NOTE =
        "학습 보조 초안입니다. 권한 있는 파일만 업로드하고, 학교·교사 기준을 확인한 뒤 직접 검토·수정해 사용하세요. 그대로 제출하면 안 됩니다.";

      function normalizeStudentId(value) {
        return String(value || "").trim().slice(0, 20);
      }

      function setStudentIdUi(value) {
        currentStudentId = normalizeStudentId(value);
        document.getElementById("settingsStudentId").textContent =
          currentStudentId || "미설정";
        document.getElementById("settingsStudentIdInput").value = currentStudentId;
      }

      function getLocalStudentId() {
        try {
          return normalizeStudentId(localStorage.getItem("studentId") || "");
        } catch (_) {
          return "";
        }
      }

      function getLocalStyleNote() {
        try { return localStorage.getItem("quiloStyleNote") || ""; } catch (_) { return ""; }
      }
      function saveLocalStyleNote(value) {
        try { localStorage.setItem("quiloStyleNote", value || ""); } catch (_) {}
      }
      function applySavedStyleNote(serverNote) {
        var note = serverNote != null && serverNote !== "" ? serverNote : getLocalStyleNote();
        if (note) saveLocalStyleNote(note);
        var s = document.getElementById("settingsStyleNote");
        if (s && !s.value) s.value = note;
        ["cpStyleNote", "crStyleNote", "prStyleNote", "piStyleNote"].forEach(function (id) {
          var el = document.getElementById(id);
          if (el && !el.value) el.value = note;
        });
      }
      function saveLocalStudentId(value) {
        try {
          localStorage.setItem("studentId", normalizeStudentId(value));
        } catch (_) { /* private mode etc. */ }
      }

      function appendPolicyAcknowledgements(fd) {
        fd.append("copyrightAccepted", "true");
        fd.append("academicIntegrityAccepted", "true");
        fd.append("policyAcceptedAt", new Date().toISOString());
      }

      // 로그인 전/후 같은 페이지(같은 골격). 로그아웃이면 리다이렉트 대신
      // 상단 '로그인' 드롭다운을 띄우고, 로그인하면 그 자리를 계정 메뉴로 바꾼다.
      // 차단된 보고서 종류 카드를 숨긴다(서버에서도 강제 — 이건 UX용).
      function applyReportTypeAccess(blocked) {
        const set = new Set(Array.isArray(blocked) ? blocked : []);
        document.querySelectorAll('input[name="reportType"]').forEach((radio) => {
          const label = radio.closest("label");
          if (!label) return;
          const hide = set.has(radio.value);
          label.style.display = hide ? "none" : "";
          if (hide && radio.checked) radio.checked = false;
        });
      }

      function applyAuth(loggedIn, d) {
        document.body.dataset.auth = loggedIn ? "in" : "out";
        document.body.classList.toggle("is-authenticated", loggedIn);
        const workspaceSummary = document.getElementById("workspaceSummary");
        if (workspaceSummary) workspaceSummary.hidden = !loggedIn;
        const loginDd = document.getElementById("loginDd");
        const acctDd = document.getElementById("acctDd");
        if (loginDd) loginDd.hidden = loggedIn;
        if (acctDd) acctDd.hidden = !loggedIn;
        if (loggedIn && d) {
          document.getElementById("user").textContent = d.user + " 님 ";
          document.getElementById("settingsUserName").textContent = d.user;
          setStudentIdUi(d.studentId || getLocalStudentId());
          applySavedStyleNote(d.styleNote);
          ["piWhoPreview", "miWhoPreview", "frWhoPreview"].forEach((pid) => {
            const whoEl = document.getElementById(pid);
            if (!whoEl) return;
            const sid = (d.studentId || getLocalStudentId() || "").trim();
            whoEl.textContent = sid
              ? `${sid} ${d.user || ""}`.trim()
              : `${d.user || "이름"} (학번 미설정 — 개인 설정에서 저장하세요)`;
          });
          document.getElementById("settingsUserRole").textContent = d.isAdmin
            ? "관리자"
            : "일반 사용자";
          if (d.isAdmin) {
            document.getElementById("adminLink").style.display = "inline";
            // Fable 5(관리자 전용 모델) 선택지 노출 — revealFable. 단 일시 차단 중이면 숨김 유지.
            if (!d.fableDisabled) {
              document.querySelectorAll("label.fable-model").forEach((l) => { l.hidden = false; });
            }
          }
          // 관리자는 서버에서 제한 면제 → 카드도 전부 표시
          applyReportTypeAccess(d.isAdmin ? [] : d.blockedReportTypes);
          if (!d.isAdmin) loadBalance();
          loadFiles();
          loadCloudStatus();
        } else {
          applyReportTypeAccess([]);
        }
      }

      // Confirm session
      // ── 상단 공지 티커(마퀴) ──────────────────────────────────────────
      function safeAnnouncementUrl(link){
        const raw=String(link==null?"":link).trim();
        if(!raw) return "";
        if(raw.startsWith("/")) return raw;
        try{
          const u=new URL(raw, window.location.origin);
          return (u.protocol==="http:"||u.protocol==="https:")?u.href:"";
        }catch(_){return "";}
      }
      async function loadAnnouncements(){
        const ticker=document.getElementById("annTicker");
        const track=document.getElementById("annTrack");
        if(!ticker||!track) return;
        try{
          const r=await fetch("/api/announcements");
          const d=await r.json();
          const list=Array.isArray(d.announcements)?d.announcements:[];
          if(!list.length){ticker.hidden=true;return;}
          const item=(a)=>{
            const href=safeAnnouncementUrl(a.link);
            const wrap=document.createElement(href?"a":"span");
            wrap.className="ann-item";
            if(href){
              wrap.href=href;
              wrap.target="_blank";
              wrap.rel="noopener";
            }
            if(a.category){
              const cat=document.createElement("span");
              cat.className="ann-cat";
              cat.textContent=String(a.category);
              wrap.appendChild(cat);
            }
            const title=document.createElement("span");
            title.textContent=String(a.title||"");
            wrap.appendChild(title);
            const dot=document.createElement("span");
            dot.className="ann-dot";
            dot.textContent="•";
            return [wrap,dot];
          };
          const textLen=list.reduce((n,a)=>n+String(a.category||"").length+String(a.title||"").length+8,0);
          // 항목이 적으면 화면을 채우도록 반복
          let reps=1; while(textLen*reps<1600 && reps<12) reps++;
          const group=document.createElement("span");
          group.className="ann-group";
          for(let i=0;i<reps;i++) list.forEach((a)=>item(a).forEach((node)=>group.appendChild(node)));
          track.replaceChildren(group.cloneNode(true), group.cloneNode(true)); // 끊김 없는 루프용 2배 복제
          const dur=Math.max(20,Math.min(90,list.length*reps*5));
          track.style.setProperty("--ann-dur",dur+"s");
          ticker.hidden=false;
        }catch(e){ticker.hidden=true;}
      }
      loadAnnouncements();

      fetch("/api/me")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => applyAuth(true, d))
        .catch(() => applyAuth(false));

      // Dropbox 연결 콜백 결과 안내(+ URL 정리)
      try {
        const _cloud = new URLSearchParams(location.search).get("cloud");
        if (_cloud === "connected") {
          alert("✅ Dropbox가 연결되었습니다. 이제 생성한 보고서가 Dropbox 앱 폴더에 영구 저장됩니다.");
          history.replaceState({}, "", location.pathname);
        } else if (_cloud === "error") {
          alert("Dropbox 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.");
          history.replaceState({}, "", location.pathname);
        }
      } catch (_) {}

      // 로그인 유지 사용자: 저장된 이름 미리 채우기
      try {
        const _saved = localStorage.getItem("lastUsername");
        const _u = document.getElementById("li_username");
        if (_saved && _u && !_u.value) _u.value = _saved;
      } catch (_) {}

      // 비밀번호 표시(눈) 토글: 가려진 비밀번호를 잠깐 보여줘 오타를 확인할 수 있게 한다.
      (function () {
        const EYE =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        const EYEOFF =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
        function addPwToggle(input) {
          if (!input || input.dataset.pwToggle) return;
          input.dataset.pwToggle = "1";
          const wrap = document.createElement("span");
          wrap.style.cssText = "position:relative;display:block";
          input.parentNode.insertBefore(wrap, input);
          wrap.appendChild(input);
          input.style.paddingRight = "40px";
          const btn = document.createElement("button");
          btn.type = "button";
          btn.tabIndex = -1;
          btn.setAttribute("aria-label", "비밀번호 표시");
          btn.title = "비밀번호 표시";
          btn.style.cssText =
            "position:absolute;top:50%;right:6px;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:30px;height:30px;background:none;border:0;cursor:pointer;color:#64748b;padding:0;border-radius:6px";
          btn.innerHTML = EYE;
          btn.addEventListener("click", () => {
            const show = input.type === "password";
            input.type = show ? "text" : "password";
            btn.innerHTML = show ? EYEOFF : EYE;
            const lab = show ? "비밀번호 숨기기" : "비밀번호 표시";
            btn.setAttribute("aria-label", lab);
            btn.title = lab;
          });
          wrap.appendChild(btn);
        }
        ["li_password", "currentPw", "newPw", "confirmPw"].forEach((id) =>
          addPwToggle(document.getElementById(id)),
        );
      })();

      // 로그인 폼(드롭다운) 제출
      document
        .getElementById("loginForm")
        ?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const err = document.getElementById("li_err");
          err.style.display = "none";
          const remember =
            document.getElementById("li_remember")?.checked !== false;
          const uname = document.getElementById("li_username").value;
          const body = {
            username: uname,
            password: document.getElementById("li_password").value,
            remember,
          };
          const btn = document.getElementById("li_btn");
          btn.disabled = true;
          btn.textContent = "로그인 중...";
          try {
            const res = await fetch("/api/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "로그인 실패");
            try {
              if (remember) localStorage.setItem("lastUsername", uname);
              else localStorage.removeItem("lastUsername");
            } catch (_) {}
            location.reload();
          } catch (ex) {
            err.textContent = ex.message;
            err.style.display = "block";
            btn.disabled = false;
            btn.textContent = "로그인";
          }
        });

      // 로그아웃 상태에서 보고서 종류를 누르면 로그인 드롭다운을 연다.
      function openLoginDropdown() {
        const dd = document.getElementById("loginDd");
        if (!dd || dd.hidden) return false;
        // 다음 틱에 연다 — 이 함수를 부른 클릭이 document 까지 버블링되며
        // closeAll() 이 돌아 방금 연 드롭다운을 즉시 닫는 것을 피한다.
        setTimeout(() => {
          document
            .querySelectorAll(".nav-dd.open")
            .forEach((d) => d.classList.remove("open"));
          dd.classList.add("open");
          document.getElementById("navMenu")?.classList.add("open");
          document.getElementById("li_username")?.focus();
        }, 0);
        return true;
      }

      // 히어로 '지금 시작하기': 로그아웃이면 로그인 드롭다운, 로그인이면 보고서 종류로.
      document.getElementById("heroStart")?.addEventListener("click", () => {
        if (document.body.dataset.auth === "out") {
          openLoginDropdown();
        } else {
          document
            .getElementById("reportTypes")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });

      async function loadBalance() {
        try {
          const r = await fetch("/api/me/balance");
          if (!r.ok) return;
          const b = await r.json();
          if (b.isAdmin) return; // admin은 잔액 X
          // 모델 제한 계정(예: 베타테스터): 허용 모델만 남기고 나머지 라디오 숨김
          if (b.restrictedModel) {
            document
              .querySelectorAll(
                'input[name="model"], input[name="crModel"], input[name="prModel"]',
              )
              .forEach((el) => {
                const lbl = el.closest("label");
                if (el.value !== b.restrictedModel) {
                  el.checked = false;
                  if (lbl) lbl.style.display = "none";
                } else {
                  el.checked = true;
                }
              });
          }
          const credits = Math.max(0, Math.trunc(Number(b.credits) || 0));
          document.getElementById("balCredits").textContent = b.unlimited
            ? "무제한 (베타)"
            : `${credits} 크레딧`;
          // 모델별 환산: 잔액이 보고서 몇 건인지 직관적으로 (개편: Sonnet 2 / Opus·GPT-5.5 4 / GPT-5.4 1 / mini 무료)
          if (!b.unlimited) {
            document.getElementById("balCredits").title =
              `≈ Sonnet ${Math.floor(credits / 2)}건 · Opus/GPT-5.5 ${Math.floor(credits / 4)}건 · GPT-5.4 ${credits}건 · mini 무료`;
            const convEl = document.getElementById("balConvert");
            if (convEl) convEl.textContent =
              `≈ Sonnet ${Math.floor(credits / 2)}건 · Opus ${Math.floor(credits / 4)}건 · GPT-5.4 ${credits}건`;
          }
          document.getElementById("balanceBox").style.display = "flex";
          document.querySelector(".report-toolbar")?.classList.add("has-balance");
        } catch (_) {
          /* graceful: 잔액 박스 숨김 */
        }
      }

      function formatBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return `${n}B`;
        if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
        return `${(n / 1024 / 1024).toFixed(1)}MB`;
      }

      function formatDateTime(value) {
        if (!value) return "-";
        return new Date(value).toLocaleString("ko-KR", {
          dateStyle: "short",
          timeStyle: "short",
        });
      }

      async function loadCloudStatus() {
        const card = document.getElementById("cloudCard");
        if (!card) return;
        const statusEl = document.getElementById("cloudStatus");
        const actions = document.getElementById("cloudActions");
        try {
          const r = await fetch("/api/cloud/status");
          if (!r.ok) {
            card.hidden = true;
            return;
          }
          const d = await r.json();
          const dp = (d && d.dropbox) || {};
          if (!dp.configured) {
            card.hidden = true; // 서버에 Dropbox 미설정 → 카드 숨김
            return;
          }
          card.hidden = false;
          if (dp.connected) {
            const note = document.createElement("span");
            note.className = "hint";
            note.textContent = "생성한 보고서가 Dropbox 앱 폴더에 영구 저장됩니다.";
            const br = document.createElement("br");
            const nodes = [document.createTextNode("✅ Dropbox 연결됨")];
            if (dp.email) {
              const email = document.createElement("b");
              email.textContent = String(dp.email);
              nodes.push(document.createTextNode(" — "), email);
            }
            statusEl.replaceChildren(...nodes, br, note);

            const btn = document.createElement("button");
            btn.type = "button";
            btn.id = "dbxDisconnectBtn";
            btn.className = "secondary compact";
            btn.textContent = "연결 해제";
            actions.replaceChildren(btn);
            if (btn)
              btn.addEventListener("click", async () => {
                if (!confirm("Dropbox 연결을 해제할까요? (이미 저장된 파일은 Dropbox에 그대로 남습니다)")) return;
                await fetch("/api/cloud/dropbox/disconnect", { method: "POST" });
                loadCloudStatus();
                if (typeof loadFiles === "function") loadFiles();
              });
          } else {
            const strong = document.createElement("b");
            strong.textContent = "24시간 파일함";
            statusEl.replaceChildren(
              document.createTextNode("연결 안 됨 — 보고서는 "),
              strong,
              document.createTextNode("에 저장됩니다."),
            );
            const isElectron = /electron|quilo/i.test(navigator.userAgent || "");
            if (isElectron) {
              // 데스크톱 앱(Electron)은 임베디드 브라우저라 Dropbox OAuth 가 막힌다.
              // 연결은 계정 단위로 저장되므로 웹사이트에서 한 번만 연결하면 앱에도 적용됨.
              const p = document.createElement("p");
              p.className = "hint";
              p.style.margin = "0";
              const b = document.createElement("b");
              b.textContent = "웹사이트(브라우저)";
              p.append(
                document.createTextNode("📱 데스크톱 앱에서는 보안상 여기서 바로 연결되지 않습니다. "),
                b,
                document.createTextNode("에서 같은 계정으로 로그인 후 한 번 연결하면, 이 앱에도 자동으로 적용됩니다."),
              );
              actions.replaceChildren(p);
            } else {
              const a = document.createElement("a");
              a.className = "btn btn-primary";
              a.href = "/api/cloud/dropbox/connect";
              a.textContent = "Dropbox 연결";
              actions.replaceChildren(a);
            }
          }
        } catch (_) {
          card.hidden = true;
        }
      }

      async function loadFiles() {
        const status = document.getElementById("filesStatus");
        const list = document.getElementById("filesList");
        const workspaceFilesSummary = document.getElementById("workspaceFilesSummary");
        const filter = document.getElementById("filesFilter");
        const filterEmpty = document.getElementById("filesFilterEmpty");
        if (!status || !list) return;
        status.textContent = "불러오는 중...";
        if (workspaceFilesSummary) workspaceFilesSummary.textContent = "최근 파일 확인 중...";
        list.innerHTML = "";
        if (filterEmpty) filterEmpty.hidden = true;
        try {
          const res = await fetch("/api/me/files");
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "파일 목록 오류");
          if (!data.storage) {
            status.textContent = "파일 저장소가 아직 설정되지 않았습니다.";
            if (workspaceFilesSummary) workspaceFilesSummary.textContent = "파일 저장소가 아직 설정되지 않았습니다.";
            return;
          }
          const isCloud = data.cloud === "dropbox";
          const files = data.files || [];
          const maxFiles = data.maxFilesPerUser || 3;
          if (files.length === 0) {
            status.textContent = isCloud
              ? "Dropbox 앱 폴더에 보관된 보고서가 없습니다."
              : `보관 중인 파일이 없습니다. 최대 ${maxFiles}개까지 저장됩니다.`;
            if (workspaceFilesSummary) workspaceFilesSummary.textContent = "최근 생성 파일이 없습니다.";
            return;
          }
          status.textContent = isCloud
            ? `${files.length}개 · ☁ Dropbox(${data.account || "연결됨"})에 영구 저장`
            : `${files.length}/${maxFiles}개 보관 중`;
          if (workspaceFilesSummary) {
            workspaceFilesSummary.textContent = isCloud
              ? `${files.length}개 파일 · Dropbox 저장`
              : `${files.length}/${maxFiles}개 파일 · 24시간 보관`;
          }
          for (const file of files) {
            const item = document.createElement("div");
            item.className = "file-item";
            item.dataset.fileSearch = [
              file.filename,
              file.size_bytes,
              file.created_at,
              file.expires_at,
              isCloud ? "dropbox" : "temporary",
            ].filter(Boolean).join(" ").toLowerCase();

            const meta = document.createElement("div");
            meta.className = "file-meta";

            const name = document.createElement("strong");
            name.textContent = file.filename || "보고서";

            const detail = document.createElement("span");
            detail.textContent = isCloud
              ? `${formatBytes(file.size_bytes)} · ${formatDateTime(file.created_at)} 생성 · ☁ Dropbox`
              : `${formatBytes(file.size_bytes)} · ${formatDateTime(file.created_at)} 생성 · ${formatDateTime(file.expires_at)} 만료`;

            meta.append(name, detail);

            const actions = document.createElement("div");
            actions.className = "file-actions";

            const download = document.createElement("a");
            if (isCloud) {
              download.href = file.download_url || "#";
              download.target = "_blank";
              download.rel = "noopener";
              download.textContent = file.download_url ? "다운로드" : "링크 없음";
            } else {
              download.href = `/api/me/files/${file.id}/download`;
              download.download = file.filename || "";
              download.textContent = "다운로드";
            }
            actions.append(download);

            // 클라우드 파일: Dropbox 웹에서 바로 열기(온디맨드 공유 링크).
            if (isCloud && file.path) {
              const open = document.createElement("button");
              open.type = "button";
              open.className = "secondary compact";
              open.textContent = "Dropbox에서 열기";
              open.addEventListener("click", async () => {
                const prev = open.textContent;
                open.disabled = true;
                open.textContent = "여는 중…";
                try {
                  const r = await fetch(
                    `/api/cloud/dropbox/link?path=${encodeURIComponent(file.path)}`,
                  );
                  const d = await r.json().catch(() => ({}));
                  if (r.ok && d.url) window.open(d.url, "_blank", "noopener");
                  else alert(d.error || "링크를 만들 수 없습니다.");
                } catch (_) {
                  alert("링크 요청에 실패했습니다.");
                }
                open.disabled = false;
                open.textContent = prev;
              });
              actions.append(open);
            }

            // 클라우드 파일은 Dropbox에 영구 보관 — 앱에서 삭제 버튼은 제공하지 않는다.
            if (!isCloud) {
              const del = document.createElement("button");
              del.type = "button";
              del.className = "secondary compact";
              del.textContent = "삭제";
              del.addEventListener("click", async () => {
                const ok = await showConfirmDialog({
                  title: "파일 삭제",
                  rows: [["파일", file.filename || "보고서"]],
                  note: "파일함에서 바로 삭제합니다.",
                  okLabel: "삭제",
                });
                if (!ok) return;
                const r = await fetch(`/api/me/files/${file.id}`, { method: "DELETE" });
                if (!r.ok) {
                  const body = await r.json().catch(() => ({}));
                  alert(body.error || "삭제 실패");
                }
                loadFiles();
              });
              actions.append(del);
            }

            item.append(meta, actions);
            list.appendChild(item);
          }
          if (filter) applyFileFilter();
        } catch (err) {
          status.textContent = err.message || "파일 목록을 불러오지 못했습니다.";
          if (workspaceFilesSummary) workspaceFilesSummary.textContent = "파일함을 불러오지 못했습니다.";
        }
      }

      function applyFileFilter() {
        const input = document.getElementById("filesFilter");
        const list = document.getElementById("filesList");
        const empty = document.getElementById("filesFilterEmpty");
        if (!input || !list) return;
        const q = input.value.trim().toLowerCase();
        let visible = 0;
        list.querySelectorAll(".file-item").forEach((item) => {
          const match = !q || (item.dataset.fileSearch || "").includes(q);
          item.hidden = !match;
          if (match) visible += 1;
        });
        if (empty) empty.hidden = !q || visible > 0;
      }

      document.getElementById("filesFilter")?.addEventListener("input", applyFileFilter);

      document.getElementById("logout").addEventListener("click", async (e) => {
        e.preventDefault();
        await fetch("/api/logout", { method: "POST" });
        location.href = "/"; // 같은 페이지로 — 로그아웃 골격(로그인 드롭다운)으로 전환
      });

      // 상단 탭 전환
      const tabButtons = document.querySelectorAll(".page-tabs [data-tab]");
      const tabPanels = document.querySelectorAll("[data-tab-panel]");
      function showTab(tabName) {
        tabButtons.forEach((btn) => {
          const active = btn.dataset.tab === tabName;
          btn.classList.toggle("active", active);
          btn.setAttribute("aria-selected", active ? "true" : "false");
        });
        tabPanels.forEach((panel) => {
          const active = panel.dataset.tabPanel === tabName;
          panel.classList.toggle("active", active);
          panel.hidden = !active;
        });
        if (tabName === "files") {
          loadFiles();
          loadCloudStatus();
        }
        if (tabName === "settings") loadUsage();
      }
      tabButtons.forEach((btn) => {
        btn.addEventListener("click", () => showTab(btn.dataset.tab));
      });
      document.getElementById("workspaceFilesBtn")?.addEventListener("click", () => showTab("files"));

      // ── 사용 내역 대시보드 ────────────────────────────────────────────────
      function escapeHtml(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]);
      }
      function modelShortName(m) {
        if (!m) return "";
        if (m.indexOf("opus") >= 0) return "Opus";
        if (m.indexOf("sonnet") >= 0) return "Sonnet";
        return m;
      }
      async function loadUsage() {
        const credEl = document.getElementById("usageCredits");
        const genEl = document.getElementById("usageGen");
        const recentEl = document.getElementById("usageRecent");
        if (!credEl) return;
        try {
          const d = await fetch("/api/me/usage").then((r) => r.json());
          if (d.isAdmin) credEl.textContent = "관리자 (무제한)";
          else if (d.unlimited) credEl.textContent = "무제한";
          else credEl.textContent = (d.credits ?? 0) + " 크레딧";
          genEl.textContent = `${d.genCount ?? 0} / ${d.genLimit ?? 5} 건`;
          const rDt = document.getElementById("usageRestrictDt");
          const rDd = document.getElementById("usageRestrict");
          if (d.restrictedModel) {
            rDt.style.display = "";
            rDd.style.display = "";
            rDd.textContent = modelShortName(d.restrictedModel) + "만 사용 가능";
          } else {
            rDt.style.display = "none";
            rDd.style.display = "none";
          }
          const list = Array.isArray(d.recent) ? d.recent : [];
          if (!list.length) {
            const p = document.createElement("p");
            p.className = "hint";
            p.textContent = "최근 생성 기록이 없습니다.";
            recentEl.replaceChildren(p);
            return;
          }
          const table = document.createElement("table");
          table.style.width = "100%";
          table.style.borderCollapse = "collapse";
          const tbody = document.createElement("tbody");
          list.forEach((x) => {
            const dt = x.date ? new Date(x.date) : null;
            const when = dt
              ? `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`
              : "-";
            const cr =
              x.credits == null ? "베타·무료" : x.credits === 0 ? "무료" : x.credits + "크레딧";
            const md = x.model ? modelShortName(String(x.model)) : "-";
            const tr = document.createElement("tr");
            [
              { text: when, style: "padding:4px 8px 4px 0;white-space:nowrap;color:var(--text-muted)" },
              { text: x.label || "생성", style: "padding:4px 8px 4px 0" },
              { text: md, style: "padding:4px 8px 4px 0" },
              { text: cr, style: "padding:4px 0;white-space:nowrap" },
            ].forEach((cell) => {
              const td = document.createElement("td");
              td.style.cssText = cell.style;
              td.textContent = String(cell.text);
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);
          recentEl.replaceChildren(table);
        } catch (e) {
          const p = document.createElement("p");
          p.className = "hint";
          p.textContent = "사용 내역을 불러오지 못했습니다.";
          recentEl.replaceChildren(p);
        }
      }

      // ── 상단 드롭다운 네비 ────────────────────────────────────────────────
      (function initNav() {
        const dds = Array.from(document.querySelectorAll(".nav-dd[data-dd]"));
        const menu = document.getElementById("navMenu");
        const closeAll = () => dds.forEach((d) => d.classList.remove("open"));

        dds.forEach((dd) => {
          const btn = dd.querySelector(".nav-dd-btn");
          btn?.addEventListener("click", (e) => {
            e.stopPropagation();
            const wasOpen = dd.classList.contains("open");
            closeAll();
            if (!wasOpen) dd.classList.add("open");
          });
        });
        // 드롭다운 바깥을 클릭할 때만 닫는다. (로그인 폼 등 .nav-dd 내부 클릭은
        // 닫지 않음 — 아이디·비번 입력하려다 창이 사라지던 문제 수정)
        document.addEventListener("click", (e) => {
          if (!e.target.closest(".nav-dd")) closeAll();
        });

        document.getElementById("navBurger")?.addEventListener("click", (e) => {
          e.stopPropagation();
          menu?.classList.toggle("open");
        });

        // 보고서 작성 드롭다운 → 보고서 종류 선택 + reports 탭으로
        document.querySelectorAll(".nav-dd-menu a[data-report]").forEach((a) => {
          a.addEventListener("click", (e) => {
            e.preventDefault();
            closeAll();
            // 로그아웃 상태면 폼 대신 로그인 드롭다운을 연다.
            if (document.body.dataset.auth === "out") {
              if (typeof openLoginDropdown === "function") openLoginDropdown();
              return;
            }
            const radio = document.querySelector(
              `input[name="reportType"][value="${a.dataset.report}"]`,
            );
            if (radio) {
              radio.checked = true;
              updateReportTypeView();
            }
            showTab("reports");
            menu?.classList.remove("open");
            document
              .getElementById("reportsPanel")
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        });

        // 내 계정 드롭다운 → 탭 전환
        document.querySelectorAll(".nav-dd-menu a[data-tab]").forEach((a) => {
          a.addEventListener("click", (e) => {
            e.preventDefault();
            showTab(a.dataset.tab);
            closeAll();
            menu?.classList.remove("open");
          });
        });
      })();

      // 베타 메뉴 노출: 관리자 또는 지정 테스터에게만 'PDF 통번역(베타)' 표시
      fetch("/api/me/beta")
        .then((r) => (r.ok ? r.json() : { features: [] }))
        .then((b) => {
          const feats = Array.isArray(b.features) ? b.features : [];
          if (feats.includes("pdf-translate")) {
            const el = document.getElementById("navBetaTranslate");
            if (el) el.hidden = false;
          }
          if (feats.includes("code-editor")) {
            const el2 = document.getElementById("navBetaEditor");
            if (el2) el2.hidden = false;
          }
          // 물리 수행평가(베타): 상단 메뉴 바로가기는 제거됨 — 진입은 '수행평가 도움' 허브로 일원화.
          // 보고서 종류 탭(rtPhysInquiry)은 평소엔 숨기고, 허브에서 '?report=phys-inquiry' 로
          // 들어올 때만 노출·자동 선택한다(아래 딥링크 처리).
          // 수행평가 도움(베타 허브): 관리자 또는 베타 테스터(coding-test·phys-inquiry)에게만 메뉴 노출.
          if (
            b.admin === true ||
            feats.includes("coding-test") ||
            feats.includes("phys-inquiry") ||
            feats.includes("math-inquiry")
          ) {
            const navEp = document.getElementById("navExamPrep");
            if (navEp) navEp.hidden = false;
          }
          // 허브에서 '/?report=phys-inquiry' 로 들어오면 해당 보고서 종류를 노출·자동 선택.
          try {
            const want = new URLSearchParams(location.search).get("report");
            if (
              want === "phys-inquiry" &&
              (b.admin === true || feats.includes("phys-inquiry"))
            ) {
              const tab = document.getElementById("rtPhysInquiry");
              if (tab) tab.hidden = false;
            }
            if (
              want === "math-inquiry" &&
              (b.admin === true || feats.includes("math-inquiry"))
            ) {
              const tab = document.getElementById("rtMathInquiry");
              if (tab) tab.hidden = false;
            }
            const radio = want && document.querySelector(
              'input[name="reportType"][value="' + want + '"]',
            );
            if (radio && !radio.disabled && document.body.dataset.auth !== "out") {
              radio.checked = true;
              if (typeof updateReportTypeView === "function") updateReportTypeView();
              const fs = document.getElementById("reportTypeFieldset");
              if (fs) fs.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          } catch (e) {}
        })
        .catch(() => {});

      // Default to today
      document.getElementById("date").value = new Date().toISOString().slice(0, 10);

      // chem-pre 폼: 이름은 마지막 입력값을 localStorage에서 복원
      try {
        const cached = JSON.parse(localStorage.getItem("chemPreUserDefaults") || "{}");
        const nameEl = document.getElementById("studentName");
        if (nameEl && cached.studentName) nameEl.value = cached.studentName;
      } catch (_) { /* ignore */ }

      // 보고서 종류 라디오 → 폼 전환
      const reportTypeRadios = document.querySelectorAll('input[name="reportType"]');
      const comingSoon = document.getElementById("comingSoon");
      const reportForms = document.querySelectorAll("[data-report-form]");
      const reportChecklist = document.getElementById("reportChecklist");
      const workspaceChecklistTitle = document.getElementById("workspaceChecklistTitle");

      const reportChecklistItems = {
        "chem-pre": {
          title: "화학 사전보고서",
          items: ["실험 매뉴얼 PDF", "보고서 날짜", "생성 버튼"],
        },
        "chem-result": {
          title: "화학 결과보고서",
          items: ["사전보고서 파일", "실험 데이터 또는 사진", "보고서 날짜", "생성 버튼"],
        },
        "phys-result": {
          title: "물리 결과보고서",
          items: [".cap 또는 엑셀/CSV/텍스트", "사진/그래프 스크린샷 선택", "학번 저장", "보고서 날짜"],
        },
        free: {
          title: "자유 보고서",
          items: ["작성 지시", "필요 자료", "출력 형식 확인", "생성 버튼"],
        },
        "phys-inquiry": {
          title: "물리 수행평가",
          items: ["탐구 주제", "필기노트/참고자료", "학번 저장", "생성 버튼"],
        },
        "math-inquiry": {
          title: "수학 수행평가",
          items: ["탐구 주제", "분석 방향", "학번 저장", "생성 버튼"],
        },
      };

      function updateReportChecklist(selected) {
        if (!reportChecklist || !workspaceChecklistTitle) return;
        const cfg = reportChecklistItems[selected];
        workspaceChecklistTitle.textContent = cfg ? cfg.title : "보고서 종류를 선택하세요";
        reportChecklist.replaceChildren();
        (cfg ? cfg.items : ["위에서 만들 보고서 종류를 먼저 고르세요."]).forEach((text) => {
          const li = document.createElement("li");
          li.textContent = text;
          reportChecklist.appendChild(li);
        });
      }

      function enhanceReportForms() {
        const optionalTitlePattern = /(AI 참고 메모|내 글 스타일|AI 이미지 생성|출력 설정)/;
        reportForms.forEach((formEl) => {
          if (formEl.dataset.flowInit) return;
          formEl.dataset.flowInit = "1";
          formEl.classList.add("report-flow");

          const flow = document.createElement("div");
          flow.className = "form-flow-steps";
          [
            ["upload", "자료"],
            ["info", "정보"],
            ["settings", "선택 설정"],
            ["generate", "생성"],
          ].forEach(([target, label], index) => {
            const step = document.createElement("button");
            step.type = "button";
            step.dataset.flowJump = target;
            step.textContent = `${index + 1}. ${label}`;
            step.addEventListener("click", () => {
              const anchor =
                target === "settings"
                  ? formEl.querySelector(":scope > .optional-settings")
                  : target === "generate"
                    ? formEl.querySelector(":scope > .form-actions")
                    : formEl.querySelector(`:scope > [data-flow-target="${target}"]`);
              anchor?.scrollIntoView({ behavior: "smooth", block: "start" });
            });
            flow.appendChild(step);
          });
          formEl.insertBefore(flow, formEl.firstChild);

          const optional = document.createElement("details");
          optional.className = "optional-settings";
          const summary = document.createElement("summary");
          summary.textContent = "선택 설정";
          const body = document.createElement("div");
          body.className = "optional-settings-body";
          optional.append(summary, body);

          Array.from(formEl.querySelectorAll(":scope > .form-section")).forEach((section) => {
            const title = section.querySelector(".form-section-title")?.textContent || "";
            if (/자료 업로드|무엇을/.test(title)) section.dataset.flowTarget = "upload";
            else if (/보고서 정보/.test(title)) section.dataset.flowTarget = "info";
            if (optionalTitlePattern.test(title)) body.appendChild(section);
          });

          const remainingNotes = Array.from(formEl.querySelectorAll(".user-notes-field")).filter((field) => {
            const directSection = field.closest(".form-section");
            return directSection && directSection.closest(".optional-settings") !== optional;
          });
          if (remainingNotes.length) {
            const noteSection = document.createElement("div");
            noteSection.className = "form-section generated-note-section";
            const head = document.createElement("div");
            head.className = "form-section-head";
            const title = document.createElement("span");
            title.className = "form-section-title";
            title.textContent = "AI 참고 메모";
            head.appendChild(title);
            noteSection.appendChild(head);
            remainingNotes.forEach((field) => noteSection.appendChild(field));
            body.insertBefore(noteSection, body.firstChild);
          }

          if (body.childElementCount) {
            const anchor = formEl.querySelector(":scope > .policy-check") || formEl.querySelector(":scope > .form-actions");
            formEl.insertBefore(optional, anchor || null);
          }
        });
      }

      enhanceReportForms();
      updateReportChecklist(null);

      function setVisible(el, visible) {
        if (visible) {
          el.removeAttribute("hidden");
        } else {
          el.setAttribute("hidden", "");
        }
      }

      const choosePrompt = document.getElementById("choosePrompt");
      function updateReportTypeView() {
        const checked = document.querySelector(
          'input[name="reportType"]:checked',
        );
        const selected = checked ? checked.value : null;
        let matched = false;

        reportForms.forEach((formEl) => {
          const active = formEl.dataset.reportForm === selected;
          formEl.classList.toggle("active", active);
          setVisible(formEl, active);
          matched = matched || active;
        });
        // 아무 종류도 안 고르면 폼 대신 안내만(로그인 직후 홈 상태).
        // 고른 종류에 폼이 없을 때만 '준비 중'.
        if (choosePrompt) setVisible(choosePrompt, !selected);
        setVisible(comingSoon, !!selected && !matched);
        updateReportChecklist(selected);
        if (!selected) return;

        if (selected === "chem-result") {
          const crDate = document.getElementById("crDate");
          if (crDate && !crDate.value) {
            crDate.value = new Date().toISOString().slice(0, 10);
          }
        } else if (selected === "phys-result") {
          const prDate = document.getElementById("prDate");
          if (prDate && !prDate.value) {
            prDate.value = new Date().toISOString().slice(0, 10);
          }
        }
      }
      reportTypeRadios.forEach((r) =>
        r.addEventListener("change", () => {
          // 로그아웃 상태면 선택을 취소하고 로그인 드롭다운을 연다.
          if (document.body.dataset.auth === "out") {
            r.checked = false;
            if (typeof openLoginDropdown === "function") openLoginDropdown();
            return;
          }
          updateReportTypeView();
        }),
      );
      updateReportTypeView();

      const form = document.getElementById("form");
      const btn = document.getElementById("btn");
      const stopBtn = document.getElementById("stopBtn");
      const progressArea = document.getElementById("progressArea");
      const progressEl = document.getElementById("progress");
      const resultArea = document.getElementById("resultArea");
      const statusTitle = document.getElementById("statusTitle");
      const crForm = document.getElementById("chemResultForm");
      const crBtn = document.getElementById("crBtn");
      const prForm = document.getElementById("physResultForm");
      const prBtn = document.getElementById("prBtn");
      const piForm = document.getElementById("physInquiryForm");
      const piBtn = document.getElementById("piBtn");
      const miForm = document.getElementById("mathInquiryForm");
      const miBtn = document.getElementById("miBtn");
      const frForm = document.getElementById("freeForm");
      const frBtn = document.getElementById("frBtn");

      document
        .querySelectorAll('#form input[name="format"]')
        .forEach((el) => el.addEventListener("change", updateChemPreFontOptions));
      updateChemPreFontOptions();
      document
        .querySelectorAll('#chemResultForm input[name="crFormat"]')
        .forEach((el) => el.addEventListener("change", updateChemResultFontOptions));
      updateChemResultFontOptions();
      document
        .querySelectorAll('#physResultForm input[name="prFormat"]')
        .forEach((el) => el.addEventListener("change", updatePhysResultFontOptions));
      updatePhysResultFontOptions();
      document
        .querySelectorAll('#physInquiryForm input[name="piFormat"]')
        .forEach((el) => el.addEventListener("change", updatePhysInquiryFontOptions));
      updatePhysInquiryFontOptions();
      document
        .querySelectorAll('#mathInquiryForm input[name="miFormat"]')
        .forEach((el) => el.addEventListener("change", updateMathInquiryFontOptions));
      updateMathInquiryFontOptions();
      document
        .querySelectorAll('#freeForm input[name="frFormat"]')
        .forEach((el) => el.addEventListener("change", updateFreeFontOptions));
      updateFreeFontOptions();

      // 파일 입력 → 드롭존: 파일명 표시 + 드래그 상태.
      // 네이티브 <input type=file>가 영역을 덮고 있어 클릭/드롭을 그대로 처리한다.
      function initDropzones() {
        document.querySelectorAll(".dropzone").forEach((dz) => {
          const input = dz.querySelector('input[type="file"]');
          if (!input || dz.dataset.dzInit) return;
          dz.dataset.dzInit = "1";
          const fileEl = dz.querySelector("[data-dz-file]");
          const render = () => {
            const files = input.files;
            if (files && files.length) {
              dz.classList.add("is-filled");
              if (fileEl)
                fileEl.textContent =
                  files.length === 1
                    ? files[0].name
                    : `${files.length}개 파일 선택됨`;
            } else {
              dz.classList.remove("is-filled");
              if (fileEl) fileEl.textContent = "";
            }
          };
          input.addEventListener("change", render);
          ["dragenter", "dragover"].forEach((ev) =>
            dz.addEventListener(ev, () => dz.classList.add("is-dragover")),
          );
          ["dragleave", "dragend", "drop"].forEach((ev) =>
            dz.addEventListener(ev, () => dz.classList.remove("is-dragover")),
          );
          render();
        });
      }
      initDropzones();

      // 진행 중인 작업 추적용 (중지·재시도 방지)
      let currentJobId = null;
      let currentEs = null;
      let activeFormEl = null; // 어떤 폼이 락 상태인지

      function lockForm(targetForm) {
        activeFormEl = targetForm;
        targetForm
          .querySelectorAll("input, button[type='submit']")
          .forEach((el) => (el.disabled = true));
        stopBtn.style.display = "inline-block";
        stopBtn.disabled = false;
      }

      function unlockForm() {
        if (activeFormEl) {
          activeFormEl
            .querySelectorAll("input, button[type='submit']")
            .forEach((el) => (el.disabled = false));
        }
        activeFormEl = null;
        stopBtn.style.display = "none";
        currentJobId = null;
        currentEs = null;
      }

      stopBtn.addEventListener("click", async () => {
        if (!currentJobId) return;
        const ok = await showConfirmDialog({
          title: "작업 중지",
          rows: [["상태", "진행 중인 작업을 중단합니다."]],
          note: "이미 사용된 토큰 비용은 발생할 수 있습니다.",
          okLabel: "중지",
        });
        if (!ok) return;
        stopBtn.disabled = true;
        stopBtn.textContent = "중지 중...";
        try {
          await fetch(`/api/jobs/${currentJobId}/abort`, { method: "POST" });
        } catch (_) {}
        // SSE는 서버가 done/error 이벤트로 닫아줌
      });

      // ── 개인 설정: 학번 저장 ────────────────────────────────────────────
      const profileForm = document.getElementById("profileForm");
      const profileBtn = document.getElementById("profileBtn");
      const profileStatus = document.getElementById("profileStatus");

      profileForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const nextStudentId = normalizeStudentId(
          document.getElementById("settingsStudentIdInput").value,
        );
        profileBtn.disabled = true;
        profileStatus.style.color = "#666";
        profileStatus.textContent = "저장 중...";

        try {
          const res = await fetch("/api/me/profile", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentId: nextStudentId }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "저장 실패");
          setStudentIdUi(data.studentId || nextStudentId);
          saveLocalStudentId(currentStudentId);
          profileStatus.style.color = "green";
          profileStatus.textContent = "저장 완료";
        } catch (err) {
          setStudentIdUi(nextStudentId);
          saveLocalStudentId(nextStudentId);
          profileStatus.style.color = "#9a6700";
          profileStatus.textContent = "이 브라우저에 저장됨";
        } finally {
          profileBtn.disabled = false;
        }
      });

      // ── 개인 설정: 내 기본 글 스타일 저장 ────────────────────────────────
      (function () {
        var btn = document.getElementById("styleSaveBtn");
        var ta = document.getElementById("settingsStyleNote");
        var status = document.getElementById("styleSaveStatus");
        if (!btn || !ta) return;
        btn.addEventListener("click", async function () {
          var note = (ta.value || "").trim();
          btn.disabled = true;
          status.style.color = "#666";
          status.textContent = "저장 중...";
          saveLocalStyleNote(note);
          ["cpStyleNote", "crStyleNote", "prStyleNote", "piStyleNote"].forEach(function (id) {
            var e = document.getElementById(id);
            if (e) e.value = note;
          });
          try {
            var res = await fetch("/api/me/profile", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ studentId: currentStudentId, styleNote: note }),
            });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || "저장 실패");
            if (data.styleNotePersisted === false) {
              status.style.color = "#9a6700";
              status.textContent = "이 브라우저에 저장됨(서버 컬럼 미설정)";
            } else {
              status.style.color = "green";
              status.textContent = "저장 완료";
            }
          } catch (err) {
            status.style.color = "#9a6700";
            status.textContent = "이 브라우저에 저장됨";
          } finally {
            btn.disabled = false;
          }
        });
      })();

      // ── 개인 설정: 기본 모델 · 양식 선호 (이 브라우저에 저장) ──────────────
      (function () {
        const modelSel = document.getElementById("prefModelSel");
        const styleSel = document.getElementById("prefStyleSel");
        const prefStatus = document.getElementById("prefSaveStatus");
        if (!modelSel || !styleSel) return;
        const PM = "prefModel",
          PS = "prefStyle";
        function getPref(k) {
          try {
            return localStorage.getItem(k) || "";
          } catch (e) {
            return "";
          }
        }
        function setPref(k, v) {
          try {
            if (v) localStorage.setItem(k, v);
            else localStorage.removeItem(k);
          } catch (e) {}
        }
        // 선호값을 보고서 폼 라디오에 반영 (세 폼의 모델 + 화학 사전 양식)
        function applyPrefsToForm() {
          const pm = getPref(PM),
            ps = getPref(PS);
          if (pm) {
            document
              .querySelectorAll(
                'input[name="model"],input[name="crModel"],input[name="prModel"]',
              )
              .forEach((r) => {
                if (r.value === pm && !r.checked) {
                  r.checked = true;
                  r.dispatchEvent(new Event("change", { bubbles: true }));
                }
              });
          }
          if (ps) {
            document.querySelectorAll('input[name="style"]').forEach((r) => {
              if (r.value === ps && !r.checked) {
                r.checked = true;
                r.dispatchEvent(new Event("change", { bubbles: true }));
              }
            });
          }
        }
        window.applyPrefsToForm = applyPrefsToForm;
        // 초기화: 저장값으로 셀렉트 채우기
        modelSel.value = getPref(PM);
        styleSel.value = getPref(PS);
        function flash(msg) {
          if (!prefStatus) return;
          prefStatus.style.color = "green";
          prefStatus.textContent = msg;
          setTimeout(() => {
            prefStatus.textContent = "";
          }, 1800);
        }
        modelSel.addEventListener("change", () => {
          setPref(PM, modelSel.value);
          applyPrefsToForm();
          flash("기본 모델 저장됨");
        });
        styleSel.addEventListener("change", () => {
          setPref(PS, styleSel.value);
          applyPrefsToForm();
          flash("기본 양식 저장됨");
        });
        // 페이지 로드 시 폼 라디오에 기본값 반영
        applyPrefsToForm();
      })();

      // ── 비밀번호 변경 ────────────────────────────────────────────────────
      const pwForm = document.getElementById("pwForm");
      const pwBtn = document.getElementById("pwBtn");
      const pwStatus = document.getElementById("pwStatus");

      pwForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const cur = document.getElementById("currentPw").value;
        const newP = document.getElementById("newPw").value;
        const confirmP = document.getElementById("confirmPw").value;

        if (newP !== confirmP) {
          pwStatus.style.color = "red";
          pwStatus.textContent = "새 비밀번호가 일치하지 않습니다.";
          return;
        }
        if (newP === cur) {
          pwStatus.style.color = "red";
          pwStatus.textContent = "새 비밀번호가 현재와 같습니다.";
          return;
        }

        pwBtn.disabled = true;
        pwStatus.style.color = "#666";
        pwStatus.textContent = "변경 중...";

        try {
          const res = await fetch("/api/me/password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentPassword: cur, newPassword: newP }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "변경 실패");
          pwStatus.style.color = "green";
          pwStatus.textContent = "변경 완료";
          pwForm.reset();
        } catch (err) {
          pwStatus.style.color = "red";
          pwStatus.textContent = err.message;
        } finally {
          pwBtn.disabled = false;
        }
      });

      // ── 건의사항/버그 제보 ────────────────────────────────────────────────
      const feedbackForm = document.getElementById("feedbackForm");
      const feedbackBtn = document.getElementById("feedbackBtn");
      const feedbackStatus = document.getElementById("feedbackStatus");

      feedbackForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        feedbackBtn.disabled = true;
        feedbackStatus.style.color = "#666";
        feedbackStatus.textContent = "전송 중...";

        const payload = {
          category: document.getElementById("feedbackCategory").value,
          title: document.getElementById("feedbackTitle").value.trim(),
          message: document.getElementById("feedbackMessage").value.trim(),
          contactEmail: document.getElementById("feedbackContactEmail").value.trim(),
          pageUrl: location.href,
        };

        try {
          const res = await fetch("/api/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "전송 실패");
          feedbackStatus.style.color = "green";
          feedbackStatus.textContent = "접수 완료";
          feedbackForm.reset();
        } catch (err) {
          feedbackStatus.style.color = "red";
          feedbackStatus.textContent = err.message || "전송 실패";
        } finally {
          feedbackBtn.disabled = false;
        }
      });

      // 모델별 가격 (per 1M tokens, USD)
      const MODEL_PRICING = {
        "claude-fable-5": { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
        "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        // OpenAI GPT (서버 lib/pricing.js 와 동일). cacheWrite = 캐시 미사용이라 input가.
        "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
        "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 },
        "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
      };

      // chem-pre 비용 추정 (PDF 1개 + 시스템 프롬프트 ~10K 토큰 + 출력 6~10K)
      // 실제 사용자 경험치 (3~5분 → 2~3분 단축, 출력 토큰도 그에 맞춰 축소).
      function estimateCost(pdfBytes, modelId) {
        const sizeKB = pdfBytes / 1024;
        const p = MODEL_PRICING[modelId] || MODEL_PRICING["claude-opus-4-8"];

        const sysCostLo = (10000 / 1e6) * p.cacheRead;
        const sysCostHi = (10000 / 1e6) * p.cacheWrite;
        const pdfTokensLo = sizeKB * 30;
        const pdfTokensHi = sizeKB * 100;
        const pdfCostLo = (pdfTokensLo / 1e6) * p.input;
        const pdfCostHi = (pdfTokensHi / 1e6) * p.input;
        const outputCostLo = (6000 / 1e6) * p.output;
        const outputCostHi = (10000 / 1e6) * p.output;
        // 웹검색은 Claude chem-pre 만 수행(GPT 는 미사용 → 검색비용 0).
        const isGpt = /^gpt/i.test(modelId || "");
        const searchCostLo = isGpt ? 0 : 1 * 0.01;
        const searchCostHi = isGpt ? 0 : 3 * 0.01;

        const lo = sysCostLo + pdfCostLo + outputCostLo + searchCostLo;
        const hi = sysCostHi + pdfCostHi + outputCostHi + searchCostHi;
        return { lo, hi, sizeKB: Math.round(sizeKB) };
      }

      // phys-result 비용 추정
      // - .cap 파일과 엑셀/CSV/텍스트는 서버에서 텍스트로 파싱됨
      // - 이미지 자료 1장 ≈ 1500 토큰
      // - 양식·평가기준 PDF (선택): 추가 입력
      // - 출력 6K~10K (5p 강제 + 실제 사용자 경험상 2~3분 작성)
      function estimatePhysResultCost({
        capBytes,
        photoCount,
        photoBytes,
        formBytes,
        rubricBytes,
        modelId,
      }) {
        const p = MODEL_PRICING[modelId] || MODEL_PRICING["claude-opus-4-8"];
        const sysCostLo = (8000 / 1e6) * p.cacheRead;
        const sysCostHi = (8000 / 1e6) * p.cacheWrite;

        // .cap 파싱 결과 텍스트 — binary 파일이 텍스트로 변환되면 매우 작음.
        // 실측: 20MB cap → ~5K 토큰. KB당 0.3 토큰 정도가 적정.
        const capTextTokens = Math.min((capBytes / 1024) * 0.3, 8000);
        const capCost = (capTextTokens / 1e6) * p.input;

        // 양식·평가기준 PDF
        const extraDocKB = (formBytes + rubricBytes) / 1024;
        const extraDocTokens = extraDocKB * 80;
        const extraDocCost = (extraDocTokens / 1e6) * p.input;

        // 사진
        const photoTokens = (photoCount || 0) * 1500;
        const photoCost = (photoTokens / 1e6) * p.input;

        // 출력 (5p 강제 + 2~3분 작성 기준)
        const outputCostLo = (6000 / 1e6) * p.output;
        const outputCostHi = (10000 / 1e6) * p.output;

        const lo = sysCostLo + capCost + extraDocCost + photoCost + outputCostLo;
        const hi = sysCostHi + capCost + extraDocCost + photoCost + outputCostHi;
        const totalKB = Math.round(
          (capBytes + photoBytes + formBytes + rubricBytes) / 1024,
        );
        return { lo, hi, totalKB };
      }

      // chem-result 비용 추정 (다중 파일 + 사진 N장)
      // - 시스템 프롬프트 ~6K 토큰
      // - 사진 1장 ≈ 1500 입력 토큰 (Claude vision 표준)
      // - 출력 8K~13K (실제 사용자 경험상 2~4분 작성)
      function estimateChemResultCost({
        preReportBytes,
        manualBytes,
        dataBytes,
        photoBytes,
        photoCount,
        modelId,
      }) {
        const p = MODEL_PRICING[modelId] || MODEL_PRICING["claude-opus-4-8"];

        const sysCostLo = (6000 / 1e6) * p.cacheRead;
        const sysCostHi = (6000 / 1e6) * p.cacheWrite;

        // PDF/docx 텍스트 입력: KB당 30~100 토큰 (실측치에 맞춤)
        const docKB = (preReportBytes + manualBytes) / 1024;
        const docTokensLo = docKB * 30;
        const docTokensHi = docKB * 100;
        const docCostLo = (docTokensLo / 1e6) * p.input;
        const docCostHi = (docTokensHi / 1e6) * p.input;

        // 데이터 파일: 엑셀이면 markdown table로 변환. 최대 30KB.
        const dataKB = Math.min(dataBytes / 1024, 30);
        const dataTokens = dataKB * 80;
        const dataCost = (dataTokens / 1e6) * p.input;

        // 사진: 1장당 ~1500 토큰 (Claude vision)
        const photoTokens = (photoCount || 0) * 1500;
        const photoCost = (photoTokens / 1e6) * p.input;

        // 출력: 8K~13K (2~4분 작성 기준)
        const outputCostLo = (8000 / 1e6) * p.output;
        const outputCostHi = (13000 / 1e6) * p.output;

        const lo = sysCostLo + docCostLo + dataCost + photoCost + outputCostLo;
        const hi = sysCostHi + docCostHi + dataCost + photoCost + outputCostHi;
        const totalKB = Math.round(
          (preReportBytes + manualBytes + dataBytes + photoBytes) / 1024,
        );
        return { lo, hi, totalKB };
      }

      function getSelectedModel() {
        // 모델 라디오에서 선택값 (없으면 기본 Opus 4.8).
        const el =
          document.querySelector('input[name="model"]:checked') ||
          document.querySelector('input[name="model"]');
        return el ? el.value : "claude-opus-4-8";
      }

      function getModelLabel(modelId) {
        if (modelId === "claude-fable-5") return "Fable 5";
        if (modelId === "claude-opus-4-8") return "Opus 4.8";
        if (modelId === "claude-opus-4-7") return "Opus 4.7";
        if (modelId === "claude-sonnet-4-6") return "Sonnet 4.6";
        return modelId || "Opus 4.8";
      }

      function getFontLabel(fontId) {
        if (fontId === "hamchorom-batang") return "함초롬바탕";
        if (fontId === "nanum-gothic") return "나눔고딕";
        if (fontId === "nanum-myeongjo") return "나눔명조";
        return "맑은 고딕";
      }

      function getChemPreFormat() {
        const formatEl = document.querySelector(
          '#form input[name="format"]:checked, #form input[name="format"][type="hidden"]'
        );
        return formatEl ? formatEl.value : "docx";
      }

      function getChemResultFormat() {
        const formatEl = document.querySelector(
          '#chemResultForm input[name="crFormat"]:checked, #chemResultForm input[name="crFormat"][type="hidden"]'
        );
        return formatEl ? formatEl.value : "docx";
      }

      function getPhysResultFormat() {
        const formatEl = document.querySelector(
          '#physResultForm input[name="prFormat"]:checked, #physResultForm input[name="prFormat"][type="hidden"]'
        );
        return formatEl ? formatEl.value : "docx";
      }

      function updateHwpxOnlyFontOptions(selectId, format) {
        const fontSelect = document.getElementById(selectId);
        if (!fontSelect) return;
        const allowHwpxOnly = format === "hwpx";
        fontSelect
          .querySelectorAll('option[data-hwpx-only="true"]')
          .forEach((option) => {
            option.hidden = !allowHwpxOnly;
            option.disabled = !allowHwpxOnly;
          });
        const selectedOption = fontSelect.options[fontSelect.selectedIndex];
        if (
          !allowHwpxOnly &&
          selectedOption &&
          selectedOption.dataset.hwpxOnly === "true"
        ) {
          fontSelect.value = "malgun-gothic";
        }
      }

      function updateChemPreFontOptions() {
        updateHwpxOnlyFontOptions("fontFace", getChemPreFormat());
      }

      function updateChemResultFontOptions() {
        updateHwpxOnlyFontOptions("crFontFace", getChemResultFormat());
      }

      function updatePhysResultFontOptions() {
        updateHwpxOnlyFontOptions("prFontFace", getPhysResultFormat());
      }

      function getPhysInquiryFormat() {
        const formatEl = document.querySelector(
          '#physInquiryForm input[name="piFormat"]:checked, #physInquiryForm input[name="piFormat"][type="hidden"]'
        );
        return formatEl ? formatEl.value : "hwpx";
      }

      function updatePhysInquiryFontOptions() {
        updateHwpxOnlyFontOptions("piFontFace", getPhysInquiryFormat());
      }

      function getMathInquiryFormat() {
        const formatEl = document.querySelector(
          '#mathInquiryForm input[name="miFormat"]:checked, #mathInquiryForm input[name="miFormat"][type="hidden"]'
        );
        return formatEl ? formatEl.value : "hwpx";
      }

      function updateMathInquiryFontOptions() {
        updateHwpxOnlyFontOptions("miFontFace", getMathInquiryFormat());
      }

      function getFreeFormat() {
        const formatEl = document.querySelector(
          '#freeForm input[name="frFormat"]:checked, #freeForm input[name="frFormat"][type="hidden"]'
        );
        return formatEl ? formatEl.value : "docx";
      }

      function updateFreeFontOptions() {
        updateHwpxOnlyFontOptions("frFontFace", getFreeFormat());
      }

      // 자유 보고서 비용 추정 — 작성지시/평가기준 텍스트 + 자료(PDF/엑셀/텍스트) + 사진.
      function estimateFreeReportCost({ docBytes, photoBytes, photoCount, textChars, modelId }) {
        const p = MODEL_PRICING[modelId] || MODEL_PRICING["claude-opus-4-8"];
        const sysCostLo = (6000 / 1e6) * p.cacheRead;
        const sysCostHi = (6000 / 1e6) * p.cacheWrite;
        const docKB = (docBytes || 0) / 1024;
        const docTokensLo = docKB * 30;
        const docTokensHi = docKB * 100;
        const docCostLo = (docTokensLo / 1e6) * p.input;
        const docCostHi = (docTokensHi / 1e6) * p.input;
        const promptTokens = ((textChars || 0) / 3); // 지시·기준·메모 텍스트
        const promptCost = (promptTokens / 1e6) * p.input;
        const photoTokens = (photoCount || 0) * 1500;
        const photoCost = (photoTokens / 1e6) * p.input;
        const outputCostLo = (6000 / 1e6) * p.output;
        const outputCostHi = (12000 / 1e6) * p.output;
        const lo = sysCostLo + docCostLo + promptCost + photoCost + outputCostLo;
        const hi = sysCostHi + docCostHi + promptCost + photoCost + outputCostHi;
        const totalKB = Math.round(((docBytes || 0) + (photoBytes || 0)) / 1024);
        return { lo, hi, totalKB };
      }

      function costRangeText(est, krwLo, krwHi) {
        return `$${est.lo.toFixed(2)} ~ $${est.hi.toFixed(2)} (약 ₩${krwLo.toLocaleString()} ~ ₩${krwHi.toLocaleString()})`;
      }

      // 생성 예상 시간(초). 출력 토큰량 × 모델 속도 + 기본 오버헤드 + 타입별 추가(웹검색).
      // 모델별 1k 출력토큰당 초: Opus 가 느리고 Sonnet 이 빠르다. 사진/데이터가 많으면
      // 입력 처리가 늘어 약간 더 걸린다.
      const OUTPUT_TOKENS = {
        "chem-pre": [6000, 10000],
        "chem-result": [8000, 13000],
        "phys-result": [6000, 10000],
        "phys-inquiry": [6000, 11000],
        "math-inquiry": [6000, 11000],
        "free": [6000, 12000],
      };
      function estimateGenSeconds(type, modelId, extraInputTokens = 0) {
        const isGpt = /^gpt/i.test(modelId || "");
        // 초/1k 출력토큰: Sonnet·GPT mini 빠름, Opus·GPT 플래그십 느림, Fable은 대형이라 가장 느림.
        const perK =
          /^claude-fable/.test(modelId || "")
            ? 45
            : modelId === "claude-sonnet-4-6"
              ? 9
              : modelId === "gpt-5.4-mini"
                ? 7
                : modelId === "gpt-5.4"
                  ? 12
                  : modelId === "gpt-5.5"
                    ? 14
                    : 16;
        const base = 25; // 입력 처리 + 문서 빌드 + 차트
        // 시약 물성 웹검색은 Claude chem-pre 만 수행(GPT chem-pre 는 웹검색 미사용).
        const webSearch = type === "chem-pre" && !isGpt ? 40 : 0;
        const [oLo, oHi] = OUTPUT_TOKENS[type] || [7000, 11000];
        const inExtra = (extraInputTokens / 1000) * (perK * 0.25); // 사진·데이터 입력분
        return {
          lo: Math.round(base + webSearch + (oLo / 1000) * perK + inExtra),
          hi: Math.round(base + webSearch + (oHi / 1000) * perK + inExtra),
        };
      }
      function formatDuration(sec) {
        const f = (s) =>
          s < 90 ? `${Math.round(s)}초` : `${Math.round(s / 60)}분`;
        return `약 ${f(sec.lo)} ~ ${f(sec.hi)}`;
      }

      function getUserNotesValue(id) {
        return (document.getElementById(id)?.value || "").trim();
      }

      function getUserNotesFile(id) {
        return document.getElementById(id)?.files?.[0] || null;
      }

      function validateUserNotesFile(file) {
        if (!file) return true;
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if (!["md", "txt"].includes(ext)) {
          alert("AI 참고 메모 파일은 .md 또는 .txt 형식만 업로드할 수 있습니다.");
          return false;
        }
        if (file.size > 256 * 1024) {
          alert("AI 참고 메모 파일은 최대 256KB까지만 업로드할 수 있습니다.");
          return false;
        }
        return true;
      }

      function userNotesSummary(notes, file = null) {
        const parts = [];
        if (notes) parts.push(`${notes.length}자 직접 입력`);
        if (file) parts.push(`${file.name} (${formatBytes(file.size)})`);
        return parts.length ? parts.join(", ") : "없음";
      }

      function showConfirmDialog({ title, rows, note, okLabel = "생성" }) {
        return new Promise((resolve) => {
          const overlay = document.createElement("div");
          overlay.className = "confirm-overlay";

          const dialog = document.createElement("section");
          dialog.className = "confirm-card";
          dialog.setAttribute("role", "dialog");
          dialog.setAttribute("aria-modal", "true");
          dialog.setAttribute("aria-labelledby", "confirmTitle");

          const heading = document.createElement("h2");
          heading.id = "confirmTitle";
          heading.textContent = title || "보고서 생성";

          const list = document.createElement("dl");
          list.className = "confirm-list";
          for (const [label, value] of rows) {
            const dt = document.createElement("dt");
            dt.textContent = label;
            const dd = document.createElement("dd");
            dd.textContent = value;
            list.append(dt, dd);
          }

          const noteEl = document.createElement("p");
          noteEl.className = "confirm-note";
          noteEl.textContent = note || "생성하시겠습니까?";

          const actions = document.createElement("div");
          actions.className = "confirm-actions";
          const cancelBtn = document.createElement("button");
          cancelBtn.type = "button";
          cancelBtn.className = "secondary";
          cancelBtn.textContent = "취소";
          const okBtn = document.createElement("button");
          okBtn.type = "button";
          okBtn.className = "primary";
          okBtn.textContent = okLabel;
          actions.append(cancelBtn, okBtn);

          dialog.append(heading, list, noteEl, actions);
          overlay.appendChild(dialog);
          document.body.appendChild(overlay);
          document.body.classList.add("modal-open");

          const close = (result) => {
            document.removeEventListener("keydown", onKeydown);
            document.body.classList.remove("modal-open");
            overlay.remove();
            resolve(result);
          };
          const onKeydown = (event) => {
            if (event.key === "Escape") close(false);
          };
          document.addEventListener("keydown", onKeydown);
          overlay.addEventListener("click", (event) => {
            if (event.target === overlay) close(false);
          });
          cancelBtn.addEventListener("click", () => close(false));
          okBtn.addEventListener("click", () => close(true));
          okBtn.focus();
        });
      }

      async function submitReport({ formEl, buttonEl, formData, busyText = "생성 중..." }) {
        lockForm(formEl);
        if (buttonEl) buttonEl.textContent = busyText;
        beginProgress("생성 중...");
        try {
          const res = await fetch("/api/generate", { method: "POST", body: formData });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "요청 실패");
          currentJobId = data.jobId;
          streamJob(data.jobId);
        } catch (err) {
          appendLine("오류: " + err.message);
          resetForm();
        }
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (currentJobId) return; // 안전장치: 진행 중이면 무시
        const file = document.getElementById("manual").files[0];
        if (!file) return;

        const model = getSelectedModel();
        const modelLabel = getModelLabel(model);
        const formatValue = getChemPreFormat();
        updateChemPreFontOptions();
        const fontFace = document.getElementById("fontFace").value;
        const userNotes = getUserNotesValue("preUserNotes");
        const userNotesFile = getUserNotesFile("preUserNotesFile");
        if (!validateUserNotesFile(userNotesFile)) return;

        // 예상 비용 확인
        const allowImageGen = document.getElementById("cpAllowImageGen")?.checked || false;
        const est = estimateCost(file.size, model);
        if (allowImageGen) est.hi += 0.08; // AI 개념도 최대 2장 × ~$0.04
        const krwLo = Math.round(est.lo * 1400);
        const krwHi = Math.round(est.hi * 1400);
        const ok = await showConfirmDialog({
          title: "사전보고서 생성",
          rows: [
            ["모델", modelLabel],
            ["글꼴", getFontLabel(fontFace)],
            ["참고 메모", userNotesSummary(userNotes, userNotesFile)],
            ["AI 이미지", allowImageGen ? "개념도 최대 2장 (장당 +1크레딧)" : "사용 안 함"],
            ["PDF", `${est.sizeKB}KB`],
            ["예상 비용", costRangeText(est, krwLo, krwHi)],
            ["예상 시간", formatDuration(estimateGenSeconds("chem-pre", model))],
          ],
          note: `실제 비용은 완료 후 표시됩니다. ${USE_POLICY_NOTE}`,
        });
        if (!ok) return;

        const fd = new FormData();
        fd.append("type", "chem-pre");
        Array.from(document.getElementById("cpStyleRefs").files).forEach((f) => fd.append("styleRefs", f));
        { const sn = (document.getElementById("cpStyleNote").value || "").trim(); if (sn) fd.append("styleNote", sn); }
        fd.append("manual", file);
        const dateStr = document.getElementById("date").value;
        const [y, m, d] = dateStr.split("-");
        fd.append("date", `${y}/ ${m} / ${d}`);
        fd.append("model", model);
        fd.append("format", formatValue);
        fd.append("allowImageGen", allowImageGen ? "true" : "false");
        // 스타일 모드 (default | minimal). docx/hwpx 모두 지원한다.
        const styleEl = document.querySelector('#form input[name="style"]:checked');
        const styleValue = styleEl ? styleEl.value : "default";
        fd.append("style", styleValue);
        fd.append("fontFace", fontFace);
        fd.append("userNotes", userNotes);
        if (userNotesFile) fd.append("userNotesFile", userNotesFile);

        // 표지에 들어갈 사용자 입력. 학번은 개인 설정값을 자동 사용한다.
        const nameEl = document.getElementById("studentName");
        const tempEl = document.getElementById("temperature");
        const presEl = document.getElementById("pressure");
        const studentId = currentStudentId;
        const studentName = nameEl?.value.trim() || "";
        const temperature = tempEl?.value.trim() || "";
        const pressure = presEl?.value.trim() || "";
        fd.append("studentId", studentId);
        fd.append("studentName", studentName);
        fd.append("temperature", temperature);
        fd.append("pressure", pressure);
        appendPolicyAcknowledgements(fd);
        try {
          localStorage.setItem(
            "chemPreUserDefaults",
            JSON.stringify({ studentName }),
          );
        } catch (_) { /* private mode etc. */ }

        await submitReport({ formEl: form, buttonEl: btn, formData: fd });
      });

      // ── 화학 결과보고서 submit (Phase 2-2: 백엔드 골격 동작) ──────────────
      crForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (currentJobId) return;

        const preReport = document.getElementById("crPreReport").files[0];
        if (!preReport) return;
        const dataFile = document.getElementById("crData").files[0] || null;
        const photos = Array.from(document.getElementById("crPhotos").files);
        const manual = document.getElementById("crManual").files[0] || null;

        // 모델 라디오에서 선택값 (없으면 기본 Opus 4.8).
        const crModel =
          document.querySelector('input[name="crModel"]:checked')?.value ||
          document.querySelector('input[name="crModel"]')?.value ||
          "claude-opus-4-8";
        const modelLabel = getModelLabel(crModel);
        const crStyle =
          document.querySelector('input[name="crStyle"]:checked')?.value ||
          "default";
        const crStyleLabel = crStyle === "minimal" ? "간단 양식" : "기본 양식";
        const crFormat = getChemResultFormat();
        updateChemResultFontOptions();
        const crFontFace = document.getElementById("crFontFace").value;
        const crUserNotes = getUserNotesValue("crUserNotes");
        const crUserNotesFile = getUserNotesFile("crUserNotesFile");
        if (!validateUserNotesFile(crUserNotesFile)) return;

        const photoBytes = photos.reduce((s, p) => s + p.size, 0);
        const est = estimateChemResultCost({
          preReportBytes: preReport.size,
          manualBytes: manual?.size || 0,
          dataBytes: (dataFile?.size || 0) + (crUserNotesFile?.size || 0),
          photoBytes,
          photoCount: photos.length,
          modelId: crModel,
        });
        const krwLo = Math.round(est.lo * 1400);
        const krwHi = Math.round(est.hi * 1400);
        const ok = await showConfirmDialog({
          title: "화학 결과보고서 생성",
          rows: [
            ["모델", modelLabel],
            ["스타일", crStyleLabel],
            ["형식", crFormat === "hwpx" ? ".hwpx (한글)" : ".docx (MS Word)"],
            ["글꼴", getFontLabel(crFontFace)],
            ["참고 메모", userNotesSummary(crUserNotes, crUserNotesFile)],
            ["출력 범위", "사전보고서 뒤에 붙일 결과 추가 작성분"],
            ["첨부", `사전보고서${dataFile ? ", 데이터" : ", 데이터 없음"}${(crUserNotes || crUserNotesFile) && !dataFile ? " (메모 활용)" : ""}, 사진 ${photos.length}장${manual ? ", 매뉴얼" : ""}`],
            ["총 크기", `${est.totalKB}KB`],
            ["예상 비용", costRangeText(est, krwLo, krwHi)],
            ["예상 시간", formatDuration(estimateGenSeconds("chem-result", crModel, photos.length * 1500))],
          ],
          note: `실제 비용은 완료 후 표시됩니다. ${USE_POLICY_NOTE}`,
        });
        if (!ok) return;

        const fd = new FormData();
        fd.append("type", "chem-result");
        Array.from(document.getElementById("crStyleRefs").files).forEach((f) => fd.append("styleRefs", f));
        { const sn = (document.getElementById("crStyleNote").value || "").trim(); if (sn) fd.append("styleNote", sn); }
        fd.append("preReport", preReport);
        if (dataFile) fd.append("data", dataFile);
        photos.forEach((p) => fd.append("photos", p));
        if (manual) fd.append("manual", manual);
        const crDateStr = document.getElementById("crDate").value;
        const [y, m, d] = crDateStr.split("-");
        fd.append("date", `${y}/ ${m} / ${d}`);
        fd.append("temperature", document.getElementById("crTemp").value || "");
        fd.append("pressure", document.getElementById("crPressure").value || "");
        fd.append("studentId", currentStudentId);
        fd.append("model", crModel);
        fd.append("style", crStyle);
        fd.append("format", crFormat);
        fd.append("fontFace", crFontFace);
        fd.append("userNotes", crUserNotes);
        if (crUserNotesFile) fd.append("userNotesFile", crUserNotesFile);
        appendPolicyAcknowledgements(fd);

        await submitReport({ formEl: crForm, buttonEl: crBtn, formData: fd });
      });

      // ── 물리 결과보고서 submit ───────────────────────────────────────────
      prForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (currentJobId) return;

        const cap = document.getElementById("prCap").files[0] || null;
        const dataFiles = Array.from(document.getElementById("prData").files);
        const manual = document.getElementById("prManual").files[0] || null;
        const photos = Array.from(document.getElementById("prPhotos").files);

        // 클라이언트 검증: cap, 엑셀/CSV, 데이터 스크린샷 중 하나는 필수
        if (!cap && dataFiles.length === 0 && photos.length === 0) {
          alert("PASCO Capstone (.cap), 엑셀/CSV/텍스트 데이터, 데이터표·그래프 스크린샷 중 하나는 업로드해야 합니다.");
          return;
        }
        if (!currentStudentId) {
          alert("개인 설정에서 학번을 저장한 뒤 생성하세요.");
          showTab("settings");
          document.getElementById("settingsStudentIdInput").focus();
          return;
        }

        // 모델 라디오에서 선택값 (없으면 기본 Opus 4.8).
        const prModel =
          document.querySelector('input[name="prModel"]:checked')?.value ||
          document.querySelector('input[name="prModel"]')?.value ||
          "claude-opus-4-8";
        const modelLabel = getModelLabel(prModel);
        const prFormat = getPhysResultFormat();
        updatePhysResultFontOptions();
        const prFontFace = document.getElementById("prFontFace").value;
        const prUserNotes = getUserNotesValue("prUserNotes");
        const prUserNotesFile = getUserNotesFile("prUserNotesFile");
        if (!validateUserNotesFile(prUserNotesFile)) return;

        const photoBytes = photos.reduce((s, p) => s + p.size, 0);
        const dataFileBytes = dataFiles.reduce((s, f) => s + f.size, 0);
        const dataInputBytes =
          (cap?.size || 0) + dataFileBytes + (prUserNotesFile?.size || 0);
        const est = estimatePhysResultCost({
          capBytes: dataInputBytes,
          photoCount: photos.length,
          photoBytes,
          formBytes: manual?.size || 0,
          rubricBytes: 0,
          modelId: prModel,
        });
        const krwLo = Math.round(est.lo * 1400);
        const krwHi = Math.round(est.hi * 1400);
        const inputLabel =
          (cap ? `.cap (${Math.round(cap.size / 1024)}KB)` : "") +
          (cap && dataFiles.length ? " + " : "") +
          (dataFiles.length
            ? `엑셀/CSV/텍스트 ${dataFiles.length}개 (${Math.round(dataFileBytes / 1024)}KB)`
            : "") +
          (!cap && dataFiles.length === 0 && photos.length ? "이미지 자료만" : "");
        const ok = await showConfirmDialog({
          title: "물리 결과보고서 생성",
          rows: [
            ["모델", modelLabel],
            ["양식", "기본 양식"],
            ["형식", prFormat === "hwpx" ? ".hwpx (한글)" : ".docx (MS Word)"],
            ["글꼴", getFontLabel(prFontFace)],
            ["참고 메모", userNotesSummary(prUserNotes, prUserNotesFile)],
            ["입력", `${inputLabel}${photos.length > 0 ? `, 사진 ${photos.length}장` : ""}${manual ? ", 매뉴얼" : ""}`],
            ["총 크기", `${est.totalKB}KB`],
            ["예상 비용", costRangeText(est, krwLo, krwHi)],
            ["예상 시간", formatDuration(estimateGenSeconds("phys-result", prModel, photos.length * 1500))],
          ],
          note: `기본 평가 기준을 적용합니다. ${USE_POLICY_NOTE}`,
        });
        if (!ok) return;

        const fd = new FormData();
        fd.append("type", "phys-result");
        Array.from(document.getElementById("prStyleRefs").files).forEach((f) => fd.append("styleRefs", f));
        { const sn = (document.getElementById("prStyleNote").value || "").trim(); if (sn) fd.append("styleNote", sn); }
        if (cap) fd.append("cap", cap);
        dataFiles.forEach((f) => fd.append("data", f));
        if (manual) fd.append("manual", manual);
        photos.forEach((p) => fd.append("photos", p));
        const prDateStr = document.getElementById("prDate").value;
        const [y, m, d] = prDateStr.split("-");
        fd.append("date", `${y}/ ${m} / ${d}`);
        fd.append("studentId", currentStudentId);
        fd.append("model", prModel);
        fd.append("format", prFormat);
        fd.append("fontFace", prFontFace);
        fd.append("userNotes", prUserNotes);
        if (prUserNotesFile) fd.append("userNotesFile", prUserNotesFile);
        appendPolicyAcknowledgements(fd);

        await submitReport({ formEl: prForm, buttonEl: prBtn, formData: fd });
      });

      // ── 물리 수행평가(베타) submit ───────────────────────────────────────
      if (piForm) {
        piForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          if (currentJobId) return;

          const topic = document.getElementById("piTopic").value.trim();
          const notes = Array.from(document.getElementById("piNotes").files);
          const refs = Array.from(document.getElementById("piRefs").files);
          const refLinks = document.getElementById("piRefLinks").value.trim();
          const styleRefs = Array.from(document.getElementById("piStyleRefs").files);
          const styleNote = document.getElementById("piStyleNote").value.trim();

          if (!topic) {
            alert("탐구 주제를 입력하세요.");
            document.getElementById("piTopic").focus();
            return;
          }
          if (notes.length === 0 && refs.length === 0 && !refLinks) {
            alert("필기노트 PDF, 참고자료 파일, 참고 링크 중 하나는 첨부하세요.");
            return;
          }

          const piModel =
            document.querySelector('input[name="piModel"]:checked')?.value ||
            "claude-opus-4-8";
          const modelLabel = getModelLabel(piModel);
          const piFormat = getPhysInquiryFormat();
          updatePhysInquiryFontOptions();
          const piFontFace = document.getElementById("piFontFace").value;
          const piUserNotes = getUserNotesValue("piUserNotes");
          const piUserNotesFile = getUserNotesFile("piUserNotesFile");
          if (!validateUserNotesFile(piUserNotesFile)) return;

          const inputBits = [];
          if (notes.length) inputBits.push(`필기노트 ${notes.length}개`);
          if (refs.length) inputBits.push(`참고자료 ${refs.length}개`);
          if (refLinks) inputBits.push(`링크 ${refLinks.split(/\s*\n\s*/).filter(Boolean).length}개`);

          const ok = await showConfirmDialog({
            title: "물리 수행평가 초안 생성 (베타)",
            rows: [
              ["모델", modelLabel],
              ["형식", piFormat === "hwpx" ? ".hwpx (한글)" : ".docx (MS Word)"],
              ["글꼴", getFontLabel(piFontFace)],
              ["주제", topic.length > 40 ? topic.slice(0, 40) + "…" : topic],
              ["입력", inputBits.join(", ") || "주제만"],
              ["참고 메모", userNotesSummary(piUserNotes, piUserNotesFile)],
              ["내 문체", styleRefs.length || styleNote ? `반영${styleRefs.length ? ` (샘플 ${styleRefs.length}개)` : ""}` : "기본"],
              ["예상 비용", "무료 (베타)"],
              ["예상 시간", formatDuration(estimateGenSeconds("phys-inquiry", piModel))],
            ],
            note: `탐구·사고 과정 성찰 보고서 양식으로 작성합니다. ${USE_POLICY_NOTE}`,
          });
          if (!ok) return;

          const fd = new FormData();
          fd.append("type", "phys-inquiry");
          fd.append("topic", topic);
          notes.forEach((f) => fd.append("notes", f));
          refs.forEach((f) => fd.append("refs", f));
          fd.append("refLinks", refLinks);
          styleRefs.forEach((f) => fd.append("styleRefs", f));
          if (styleNote) fd.append("styleNote", styleNote);
          const piDateStr = document.getElementById("piDate").value;
          if (piDateStr) {
            const [y, m, d] = piDateStr.split("-");
            fd.append("date", `${y}/ ${m} / ${d}`);
          }
          if (currentStudentId) fd.append("studentId", currentStudentId);
          fd.append("model", piModel);
          fd.append("format", piFormat);
          fd.append("fontFace", piFontFace);
          fd.append("userNotes", piUserNotes);
          if (piUserNotesFile) fd.append("userNotesFile", piUserNotesFile);
          appendPolicyAcknowledgements(fd);

          await submitReport({ formEl: piForm, buttonEl: piBtn, formData: fd });
        });
      }

      // ── 수학 수행평가(베타) submit — 주제(+선택 메모·문체)만 입력 ─────────
      if (miForm) {
        miForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          if (currentJobId) return;

          const topic = document.getElementById("miTopic").value.trim();
          const styleRefs = Array.from(document.getElementById("miStyleRefs").files);
          const styleNote = document.getElementById("miStyleNote").value.trim();

          if (!topic) {
            alert("탐구 주제를 입력하세요.");
            document.getElementById("miTopic").focus();
            return;
          }

          const miModel =
            document.querySelector('input[name="miModel"]:checked')?.value ||
            "claude-opus-4-8";
          const modelLabel = getModelLabel(miModel);
          const miFormat = getMathInquiryFormat();
          updateMathInquiryFontOptions();
          const miFontFace = document.getElementById("miFontFace").value;
          const miUserNotes = getUserNotesValue("miUserNotes");
          const miUserNotesFile = getUserNotesFile("miUserNotesFile");
          if (!validateUserNotesFile(miUserNotesFile)) return;

          const ok = await showConfirmDialog({
            title: "수학 수행평가 초안 생성 (베타)",
            rows: [
              ["모델", modelLabel],
              ["형식", miFormat === "hwpx" ? ".hwpx (한글)" : ".docx (MS Word)"],
              ["글꼴", getFontLabel(miFontFace)],
              ["주제", topic.length > 40 ? topic.slice(0, 40) + "…" : topic],
              ["참고 메모", userNotesSummary(miUserNotes, miUserNotesFile)],
              ["내 문체", styleRefs.length || styleNote ? `반영${styleRefs.length ? ` (샘플 ${styleRefs.length}개)` : ""}` : "기본"],
              ["예상 비용", "무료 (베타)"],
              ["예상 시간", formatDuration(estimateGenSeconds("math-inquiry", miModel))],
            ],
            note: `주제만으로 AI가 수학 전개·웹 검색을 통해 수학Ⅲ 급수 탐구보고서 양식(Ⅰ~Ⅴ)으로 작성합니다. ${USE_POLICY_NOTE}`,
          });
          if (!ok) return;

          const fd = new FormData();
          fd.append("type", "math-inquiry");
          fd.append("topic", topic);
          styleRefs.forEach((f) => fd.append("styleRefs", f));
          if (styleNote) fd.append("styleNote", styleNote);
          const miDateStr = document.getElementById("miDate").value;
          if (miDateStr) {
            const [y, m, d] = miDateStr.split("-");
            fd.append("date", `${y}/ ${m} / ${d}`);
          }
          if (currentStudentId) fd.append("studentId", currentStudentId);
          fd.append("model", miModel);
          fd.append("format", miFormat);
          fd.append("fontFace", miFontFace);
          fd.append("userNotes", miUserNotes);
          if (miUserNotesFile) fd.append("userNotesFile", miUserNotesFile);
          appendPolicyAcknowledgements(fd);

          await submitReport({ formEl: miForm, buttonEl: miBtn, formData: fd });
        });
      }

      // ── 자유 보고서 submit ───────────────────────────────────────────────
      if (frForm) {
        frForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          if (currentJobId) return;

          const instructions = document.getElementById("frInstructions").value.trim();
          if (!instructions) {
            alert("어떤 보고서를 어떻게 쓸지 '작성 지시'를 입력하세요.");
            document.getElementById("frInstructions").focus();
            return;
          }
          const grading = document.getElementById("frGrading").value.trim();
          const title = document.getElementById("frTitle").value.trim();
          const refLinks = document.getElementById("frRefLinks").value.trim();
          const files = Array.from(document.getElementById("frFiles").files);
          const photos = Array.from(document.getElementById("frPhotos").files);
          const styleRefs = Array.from(document.getElementById("frStyleRefs").files);
          const styleNote = document.getElementById("frStyleNote").value.trim();

          const frModel =
            document.querySelector('input[name="frModel"]:checked')?.value ||
            "claude-opus-4-8";
          const modelLabel = getModelLabel(frModel);
          const frFormat = getFreeFormat();
          updateFreeFontOptions();
          const frFontFace = document.getElementById("frFontFace").value;
          const frUserNotes = getUserNotesValue("frUserNotes");
          const frUserNotesFile = getUserNotesFile("frUserNotesFile");
          if (!validateUserNotesFile(frUserNotesFile)) return;

          const photoBytes = photos.reduce((s, p) => s + p.size, 0);
          const docBytes =
            files.reduce((s, f) => s + f.size, 0) + (frUserNotesFile?.size || 0);
          const est = estimateFreeReportCost({
            docBytes,
            photoBytes,
            photoCount: photos.length,
            textChars: instructions.length + grading.length + frUserNotes.length + refLinks.length,
            modelId: frModel,
          });
          const krwLo = Math.round(est.lo * 1400);
          const krwHi = Math.round(est.hi * 1400);
          const ok = await showConfirmDialog({
            title: "자유 보고서 생성",
            rows: [
              ["모델", modelLabel],
              ["형식", frFormat === "hwpx" ? ".hwpx (한글)" : ".docx (MS Word)"],
              ["글꼴", getFontLabel(frFontFace)],
              ["참고 메모", userNotesSummary(frUserNotes, frUserNotesFile)],
              ["첨부", `자료 ${files.length}개, 사진 ${photos.length}장`],
              ["내 문체", styleRefs.length || styleNote ? `반영${styleRefs.length ? ` (샘플 ${styleRefs.length}개)` : ""}` : "기본"],
              ["총 크기", `${est.totalKB}KB`],
              ["예상 비용", costRangeText(est, krwLo, krwHi)],
              ["예상 시간", formatDuration(estimateGenSeconds("free", frModel, photos.length * 1500))],
            ],
            note: `작성 지시·평가 기준에 맞춰 자유 형식으로 작성합니다. 실제 비용은 완료 후 표시됩니다. ${USE_POLICY_NOTE}`,
          });
          if (!ok) return;

          const fd = new FormData();
          fd.append("type", "free");
          fd.append("instructions", instructions);
          if (grading) fd.append("gradingCriteria", grading);
          if (title) fd.append("title", title);
          if (refLinks) fd.append("refLinks", refLinks);
          files.forEach((f) => fd.append("files", f));
          photos.forEach((p) => fd.append("photos", p));
          styleRefs.forEach((f) => fd.append("styleRefs", f));
          if (styleNote) fd.append("styleNote", styleNote);
          const frDateStr = document.getElementById("frDate").value;
          if (frDateStr) {
            const [y, m, d] = frDateStr.split("-");
            fd.append("date", `${y}/ ${m} / ${d}`);
          }
          if (currentStudentId) fd.append("studentId", currentStudentId);
          fd.append("model", frModel);
          fd.append("format", frFormat);
          fd.append("fontFace", frFontFace);
          fd.append("userNotes", frUserNotes);
          if (frUserNotesFile) fd.append("userNotesFile", frUserNotesFile);
          appendPolicyAcknowledgements(fd);

          await submitReport({ formEl: frForm, buttonEl: frBtn, formData: fd });
        });
      }

      const progressStepOrder = ["upload", "analysis", "document", "ready"];

      function resetProgressSteps() {
        document.querySelectorAll("[data-progress-step]").forEach((el) => {
          el.classList.remove("is-active", "is-done", "is-error");
        });
      }

      function setProgressStep(step, state = "active") {
        const idx = progressStepOrder.indexOf(step);
        if (idx < 0) return;
        document.querySelectorAll("[data-progress-step]").forEach((el) => {
          const currentIdx = progressStepOrder.indexOf(el.dataset.progressStep);
          el.classList.toggle("is-done", state !== "error" && currentIdx >= 0 && currentIdx < idx);
          el.classList.toggle("is-active", state !== "error" && currentIdx === idx);
          el.classList.toggle("is-error", state === "error" && currentIdx === idx);
        });
      }

      function inferProgressStep(text) {
        const s = String(text || "");
        if (/오류|실패|중단|취소/.test(s)) return { step: "document", state: "error" };
        if (/완료|다운로드|저장|파일 준비/.test(s)) return { step: "ready", state: "active" };
        if (/문서|DOCX|HWPX|차트|그래프|렌더|생성/.test(s)) return { step: "document", state: "active" };
        if (/AI|분석|모델|응답|작성|파싱|보정/.test(s)) return { step: "analysis", state: "active" };
        if (/업로드|파일|입력|확인|검증/.test(s)) return { step: "upload", state: "active" };
        return null;
      }

      function beginProgress(title) {
        progressArea.style.display = "block";
        progressEl.replaceChildren();
        resultArea.replaceChildren();
        statusTitle.textContent = title || "생성 중...";
        resetProgressSteps();
        setProgressStep("upload");
      }

      function appendLine(text) {
        const line = typeof text === "string" ? text : JSON.stringify(text);
        progressEl.appendChild(document.createTextNode(line + "\n"));
        progressEl.scrollTop = progressEl.scrollHeight;
        const next = inferProgressStep(line);
        if (next) setProgressStep(next.step, next.state);
      }

      function resetForm() {
        unlockForm();
        btn.textContent = "사전보고서 생성";
        if (crBtn) crBtn.textContent = "결과보고서 생성";
        if (prBtn) prBtn.textContent = "물리 결과보고서 생성";
        if (piBtn) piBtn.textContent = "물리 수행평가 초안 생성";
        if (miBtn) miBtn.textContent = "수학 수행평가 초안 생성";
        if (frBtn) frBtn.textContent = "자유 보고서 생성";
        stopBtn.textContent = "중지";
        const genSpinner = document.getElementById("genSpinner");
        if (genSpinner) genSpinner.style.display = "none";
      }

      function streamJob(jobId) {
        const es = new EventSource(`/api/jobs/${jobId}/stream`);
        currentEs = es;
        const genSpinner = document.getElementById("genSpinner");
        if (genSpinner) genSpinner.style.display = "inline-block";

        es.addEventListener("progress", (e) => {
          appendLine(JSON.parse(e.data));
        });

        es.addEventListener("done", (e) => {
          const data = JSON.parse(e.data);
          appendLine("완료");
          statusTitle.textContent = "완료";
          setProgressStep("ready");
          if (genSpinner) genSpinner.style.display = "none";

          const link = document.createElement("a");
          link.href = `/api/jobs/${jobId}/download`;
          link.textContent = `${data.filename} 다운로드`;
          link.download = data.filename;
          resultArea.appendChild(link);

          // 데이터·메모 이상 점검 결과(참고 사항) — 결과 아래에 표시
          if (Array.isArray(data.warnings) && data.warnings.length) {
            const box = document.createElement("div");
            box.style.cssText =
              "margin-top:12px;padding:12px 14px;border:1px solid #f0c36d;background:#fff8e6;border-radius:10px;color:#7a5b00;font-size:14px;line-height:1.6";
            const head = document.createElement("div");
            head.style.cssText = "font-weight:700;margin-bottom:6px";
            head.textContent = "⚠️ 참고 사항 — 업로드한 데이터/메모에서 확인이 필요한 점";
            box.appendChild(head);
            const ul = document.createElement("ul");
            ul.style.cssText = "margin:0;padding-left:18px";
            data.warnings.forEach((w) => {
              const li = document.createElement("li");
              li.textContent = w;
              ul.appendChild(li);
            });
            box.appendChild(ul);
            const note = document.createElement("div");
            note.style.cssText = "margin-top:8px;font-size:12px;color:#9a7b1a";
            note.textContent =
              "보고서는 정상 생성되었습니다. 위 사항이 의도한 것이면 무시해도 되고, 데이터·메모를 고쳐 다시 생성하면 더 정확해집니다.";
            box.appendChild(note);
            resultArea.appendChild(box);
          }

          // 업로드한 .hwpx 글꼴 상세 분석 결과 — 결과 아래에 표시
          const sf = data.styleFont;
          if (sf && (sf.bodyFace || (sf.profile && sf.profile.length))) {
            const fb = document.createElement("div");
            fb.style.cssText =
              "margin-top:12px;padding:12px 14px;border:1px solid #cdd6f4;background:#f5f7ff;border-radius:10px;color:#2a3556;font-size:13.5px;line-height:1.7";
            const h = document.createElement("div");
            h.style.cssText = "font-weight:700;margin-bottom:4px";
            h.textContent = "🖊 감지된 글꼴 구성 (업로드한 한글파일 기준)";
            fb.appendChild(h);
            const sum = document.createElement("div");
            const bodyLabel = document.createElement("b");
            bodyLabel.textContent = "본문";
            sum.append(
              bodyLabel,
              document.createTextNode(` ${sf.bodyFace || "-"}${sf.bodySizePt ? " " + sf.bodySizePt + "pt" : ""}`),
            );
            if (sf.headingFace) {
              const headLabel = document.createElement("b");
              headLabel.textContent = "제목/소제목";
              sum.append(
                document.createTextNode("  ·  "),
                headLabel,
                document.createTextNode(
                  ` ${sf.headingFace}${sf.headingSizePt ? " " + sf.headingSizePt + "pt" : ""}${sf.headingBold ? " 굵게" : ""}`,
                ),
              );
            }
            fb.appendChild(sum);
            if (sf.profile && sf.profile.length) {
              const det = document.createElement("details");
              det.style.cssText = "margin-top:6px";
              const sm = document.createElement("summary");
              sm.style.cssText = "cursor:pointer;color:#465089;font-size:12.5px";
              sm.textContent = `텍스트별 글꼴 상세 (${sf.profile.length}종)`;
              det.appendChild(sm);
              const ul2 = document.createElement("ul");
              ul2.style.cssText = "margin:6px 0 0;padding-left:18px;font-size:12.5px;color:#4a5578";
              sf.profile.forEach((c) => {
                const li = document.createElement("li");
                li.textContent = `${c.face} ${c.sizePt}pt${c.bold ? " 굵게" : ""} — ${c.share}%`;
                ul2.appendChild(li);
              });
              det.appendChild(ul2);
              fb.appendChild(det);
            }
            const fn = document.createElement("div");
            fn.style.cssText = "margin-top:7px;font-size:12px;color:#6b76a8";
            fn.textContent =
              "보고서는 본문 글꼴로 출력했습니다(그 글꼴이 PC에 설치돼 있어야 그대로 보입니다). 글자 크기·제목 글꼴까지 맞추려면 알려주세요.";
            fb.appendChild(fn);
            resultArea.appendChild(fb);
          }

          // AI로 이어서 편집 — 인수인계 프롬프트(복사용)
          if (typeof data.handoff === "string" && data.handoff.trim()) {
            const hb = document.createElement("div");
            hb.style.cssText =
              "margin-top:12px;padding:12px 14px;border:1px solid #cde3d2;background:#f3fbf5;border-radius:10px;color:#214a31;font-size:13.5px;line-height:1.6";
            const hh = document.createElement("div");
            hh.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px";
            const hhTitle = document.createElement("b");
            hhTitle.textContent = "🤝 AI로 이어서 편집하기";
            hh.appendChild(hhTitle);
            const copyBtn = document.createElement("button");
            copyBtn.textContent = "프롬프트 복사";
            copyBtn.style.cssText =
              "margin-left:auto;font-size:12.5px;padding:5px 12px;border:1px solid #2f9e57;background:#2f9e57;color:#fff;border-radius:8px;cursor:pointer";
            hh.appendChild(copyBtn);
            hb.appendChild(hh);
            const desc = document.createElement("div");
            desc.style.cssText = "font-size:12.5px;color:#4a6b54;margin-bottom:7px";
            desc.textContent =
              "아래 안내문을 복사해 ChatGPT·Claude 등에 붙여넣고, 그 아래에 다운로드한 보고서 내용을 붙이면 이어서 다듬을 수 있어요(주의사항·다듬을 포인트 포함).";
            hb.appendChild(desc);
            const ta = document.createElement("textarea");
            ta.readOnly = true;
            ta.value = data.handoff;
            ta.style.cssText =
              "width:100%;min-height:160px;font-size:12.5px;line-height:1.55;padding:10px;border:1px solid #cde3d2;border-radius:8px;background:#fff;color:#214a31;resize:vertical;white-space:pre-wrap";
            hb.appendChild(ta);
            copyBtn.onclick = () => {
              ta.select();
              navigator.clipboard?.writeText(data.handoff).then(
                () => { copyBtn.textContent = "복사됨 ✓"; setTimeout(() => (copyBtn.textContent = "프롬프트 복사"), 1500); },
                () => { try { document.execCommand("copy"); copyBtn.textContent = "복사됨 ✓"; } catch {} },
              );
            };
            resultArea.appendChild(hb);
          }

          es.close();
          resetForm();
          // 작업 후 잔액 자동 새로고침
          if (typeof loadBalance === "function") loadBalance();
          if (typeof loadFiles === "function") loadFiles();
        });

        es.addEventListener("error", (e) => {
          const msg = e.data
            ? JSON.parse(e.data)
            : "서버 연결이 끊겼습니다. 보통 (1) 서버 재배포로 컨테이너가 재시작되었거나 (2) 무료 플랜 일시 sleep 진입 시 발생합니다. 이 경우 크레딧(쿠폰)은 차감되지 않습니다. 1~2분 기다린 뒤 보고서 생성을 다시 시도하세요. (이전 작업은 복구 불가 — 새로 만들어집니다)";
          appendLine("오류: " + msg);
          statusTitle.textContent = "오류";
          if (genSpinner) genSpinner.style.display = "none";
          es.close();
          resetForm();
        });
      }
