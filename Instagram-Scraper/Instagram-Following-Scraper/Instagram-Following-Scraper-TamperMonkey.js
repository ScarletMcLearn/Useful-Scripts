// ==UserScript==
// @name         IG Following Scraper — Manual Stop Only + Live Logs (No Auto Stop)
// @namespace    ig-following-scraper
// @version      3.0.0
// @description  Collect usernames from the “Following” modal. Never auto-stops. Click again to Stop & Download. Live HUD + console logs.
// @match        https://www.instagram.com/*/following
// @match        https://www.instagram.com/*/following/
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_download
// ==/UserScript==

(() => {
  "use strict";

  // =========================
  // CONFIG
  // =========================
  const CFG = {
    // pacing
    scrollPauseMs: 600,        // wait between cycles
    endProbeIntervalMs: 200,   // short sleeps during aggressive bursts
    jiggleEvery: 3,            // every N cycles, do jiggle

    // UI / HUD
    btnTextIdle: "▶ Scrape Following",
    btnTextStop: "🛑 Stop & Download",
    btnTextRunningPrefix: "⏳",
    hudMaxLines: 120,
    hudCollapsedAtStart: false,

    // output
    downloadOnManualStop: true,
    downloadFormat: "txt",     // "txt" | "csv" | "json"
    downloadFilename: "following_usernames",

    // diagnostics
    verbose: true,             // console logs
  };

  // =========================
  // Utilities & Logging
  // =========================
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const now = () => new Date().toLocaleTimeString();

  // HUD
  let hud, hudBody, hudHeader, hudCount;
  function ensureStyles() {
    if (typeof GM_addStyle === "function") {
      GM_addStyle(`
        .igfs-btn{
          position:fixed;bottom:16px;right:16px;z-index:2147483646;
          font:14px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
          padding:10px 14px;border-radius:12px;border:1px solid #3a3a3a;
          background:#262626;color:#fff;box-shadow:0 6px 18px rgba(0,0,0,.35);
          cursor:pointer;user-select:none
        }
        .igfs-btn.running{background:#0a84ff;border-color:#0a84ff}
        .igfs-hud{
          position:fixed;left:16px;bottom:16px;width:420px;max-height:40vh;
          background:#111c;backdrop-filter: blur(4px);color:#e6e6e6;
          border:1px solid #333;border-radius:12px;z-index:2147483645;
          display:flex;flex-direction:column;overflow:hidden;font:12px/1.4 ui-monospace,Menlo,monospace
        }
        .igfs-hdr{
          display:flex;justify-content:space-between;align-items:center;
          padding:8px 10px;background:#1b1b1bcc;border-bottom:1px solid #333
        }
        .igfs-hdr button{background:#272727;color:#ddd;border:1px solid #444;padding:4px 8px;border-radius:8px;cursor:pointer}
        .igfs-body{padding:8px 10px;overflow:auto;white-space:pre-wrap}
        .igfs-count{font-weight:600}
        .igfs-row.warn{color:#ffd166}
        .igfs-row.err{color:#ff6b6b}
        .igfs-row.ok{color:#8bdc8b}
      `);
    }
  }
  function makeHUD() {
    hud = document.createElement("div");
    hud.className = "igfs-hud";
    hudHeader = document.createElement("div");
    hudHeader.className = "igfs-hdr";
    const title = document.createElement("div");
    title.textContent = "IGFS Logs";
    hudCount = document.createElement("div");
    hudCount.className = "igfs-count";
    hudCount.textContent = "users: 0 • cycles: 0 • stall: 0";
    const btns = document.createElement("div");
    const toggle = document.createElement("button");
    toggle.textContent = CFG.hudCollapsedAtStart ? "Expand" : "Collapse";
    const clear = document.createElement("button");
    clear.textContent = "Clear";
    btns.appendChild(toggle);
    btns.appendChild(clear);
    hudHeader.appendChild(title);
    hudHeader.appendChild(hudCount);
    hudHeader.appendChild(btns);
    hudBody = document.createElement("div");
    hudBody.className = "igfs-body";
    hud.appendChild(hudHeader);
    hud.appendChild(hudBody);
    document.body.appendChild(hud);

    let collapsed = CFG.hudCollapsedAtStart;
    const setCollapsed = (c) => {
      collapsed = c;
      hudBody.style.display = collapsed ? "none" : "block";
      toggle.textContent = collapsed ? "Expand" : "Collapse";
    };
    setCollapsed(collapsed);
    toggle.onclick = () => setCollapsed(!collapsed);
    clear.onclick = () => (hudBody.textContent = "");
  }
  function pushHUD(msg, level="") {
    const row = document.createElement("div");
    row.className = `igfs-row ${level}`;
    row.textContent = `[${now()}] ${msg}`;
    hudBody.appendChild(row);
    while (hudBody.childNodes.length > CFG.hudMaxLines) {
      hudBody.removeChild(hudBody.firstChild);
    }
    hudBody.scrollTop = hudBody.scrollHeight;
  }

  const clog  = (...a) => { if (CFG.verbose) console.log("[IGFS]", ...a);  pushHUD(a.join(" ")); };
  const cwarn = (...a) => { console.warn("[IGFS]", ...a);                  pushHUD(a.join(" "), "warn"); };
  const cerr  = (...a) => { console.error("[IGFS]", ...a);                 pushHUD(a.join(" "), "err"); };
  const cok   = (...a) => { if (CFG.verbose) console.log("[IGFS]", ...a);  pushHUD(a.join(" "), "ok"); };

  function download(name, text, type = "text/plain") {
    try {
      if (typeof GM_download === "function") {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        GM_download({ url, name, onload: () => URL.revokeObjectURL(url) });
        return;
      }
    } catch {}
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  function format(list) {
    switch (CFG.downloadFormat) {
      case "json": return JSON.stringify(list, null, 2);
      case "csv":  return list.map(u => `"${u.replace(/"/g, '""')}"`).join("\n");
      default:     return list.join("\n");
    }
  }
  function withExt(base) {
    return CFG.downloadFormat === "json" ? `${base}.json`
         : CFG.downloadFormat === "csv"  ? `${base}.csv`
         : `${base}.txt`;
  }

  // =========================
  // DOM helpers
  // =========================
  function findDialog() {
    return document.querySelector('div[role="dialog"]');
  }
  function findScrollContainer(dialog) {
    if (!dialog) return null;
    const nodes = dialog.querySelectorAll("*");
    for (const el of nodes) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && (el.scrollHeight > el.clientHeight + 20)) {
        return el;
      }
    }
    return dialog;
  }
  function anchorLooksLikeProfile(a) {
    const href = a.getAttribute("href") || "";
    if (!href.startsWith("/")) return false;
    const parts = href.split("/").filter(Boolean);
    if (parts.length !== 1) return false; // expect /username/
    const bad = new Set(["reel","reels","explore","accounts","direct","p"]);
    return !bad.has(parts[0].toLowerCase());
  }
  function extractUsernames(root) {
    const set = new Set();
    const anchors = root.querySelectorAll('a[role="link"][href^="/"]');
    for (const a of anchors) {
      if (!anchorLooksLikeProfile(a)) continue;
      const visible = (a.textContent || "").trim();
      const handle = visible && !visible.includes("•")
        ? visible
        : (a.getAttribute("href").split("/").filter(Boolean)[0] || "").trim();
      if (handle) set.add(handle);
    }
    return set;
  }
  function nearBottom(el) {
    if (!el) return false;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    return gap < 12;
  }
  async function nudge(el) {
    el.scrollTop = Math.min(el.scrollTop + Math.floor(el.clientHeight * 0.95), el.scrollHeight);
  }
  async function jiggle(el) {
    el.scrollTop = Math.max(0, el.scrollTop - Math.floor(el.clientHeight * 0.2));
    await sleep(60);
    el.scrollTop = Math.min(el.scrollTop + Math.floor(el.clientHeight * 1.2), el.scrollHeight);
  }
  async function hardBurst(el, count = 6) {
    for (let i = 0; i < count; i++) {
      await nudge(el);
      await sleep(40);
    }
    // viewport bounce too
    window.scrollBy(0, 200);
    await sleep(20);
    window.scrollBy(0, -200);
  }
  async function topBottomBounce(el) {
    el.scrollTop = 0;
    await sleep(120);
    el.scrollTop = el.scrollHeight;
  }

  // =========================
  // UI
  // =========================
  ensureStyles();
  makeHUD();

  const btn = document.createElement("button");
  btn.className = "igfs-btn";
  btn.textContent = CFG.btnTextIdle;
  document.body.appendChild(btn);

  let running = false;
  let stopping = false;
  let cycle = 0;
  let stallCycles = 0;

  btn.addEventListener("click", () => {
    if (!running) start();
    else {
      stopping = true;
      btn.textContent = CFG.btnTextStop;
      cwarn("Manual stop requested.");
      pushHUD("Manual stop requested.", "warn");
    }
  });

  async function start() {
    running = true;
    stopping = false;
    cycle = 0;
    stallCycles = 0;
    btn.classList.add("running");
    btn.textContent = `${CFG.btnTextRunningPrefix} starting…`;
    clog("Starting scraper. No auto-stop; will run until you click Stop.");

    const usernames = new Set();

    // Keep observers short-lived; we poll anyway
    const refresh = (root) => {
      const before = usernames.size;
      const snap = extractUsernames(root);
      for (const u of snap) usernames.add(u);
      const added = usernames.size - before;
      return { added, total: usernames.size };
    };

    // main loop: NEVER breaks unless stopping==true
    while (running && !stopping) {
      try {
        // 1) ensure modal
        let dialog = findDialog();
        if (!dialog) {
          cwarn("Following modal not found — waiting for it to open...");
          pushHUD("Waiting for modal… open your Following dialog", "warn");
          let waited = 0;
          while (!dialog && !stopping) {
            await sleep(300);
            waited += 300;
            if (waited % 3000 === 0) cwarn(`Still waiting for modal (${waited/1000}s)…`);
            dialog = findDialog();
          }
          if (stopping) break;
        }

        // 2) scrollable
        const scrollEl = findScrollContainer(dialog);
        if (!scrollEl) {
          cwarn("Scrollable container not found — retrying in 500ms");
          await sleep(500);
          continue; // do not stop
        }

        // 3) refresh
        const { added, total } = refresh(dialog);
        if (added > 0) {
          stallCycles = 0;
          cok(`+${added} (total ${total})`);
        } else {
          stallCycles++;
          clog(`no growth (total ${total}); stallCycles=${stallCycles}`);
        }
        hudCount.textContent = `users: ${total} • cycles: ${cycle} • stall: ${stallCycles}`;

        // 4) drive loading
        if (nearBottom(scrollEl)) {
          clog("nearBottom → hardBurst");
          await hardBurst(scrollEl);
        } else {
          await nudge(scrollEl);
        }

        // 5) staged recovery if stalled (never stops, only tries harder)
        if (stallCycles > 0) {
          if (stallCycles % 3 === 0) {
            clog("stall jiggle()");
            await jiggle(scrollEl);
          }
          if (stallCycles % 10 === 0) {
            cwarn("stall hardBurst(10)");
            await hardBurst(scrollEl, 10);
          }
          if (stallCycles % 20 === 0) {
            cwarn("stall topBottomBounce()");
            await topBottomBounce(scrollEl);
          }
          if (stallCycles % 40 === 0) {
            cwarn("⚠ Still no growth. If this persists, extensions/AV may be blocking IG AJAX (ERR_BLOCKED_BY_CLIENT). The script will keep running.");
          }
        }

        // 6) wait before next cycle
        cycle++;
        btn.textContent = `${CFG.btnTextRunningPrefix} ${total} users • cycle ${cycle} • stall ${stallCycles}`;
        await sleep(CFG.scrollPauseMs);

      } catch (e) {
        cerr("Loop error:", e);
        // crash-guard: keep going
        await sleep(500);
      }
    }

    // finalize only on manual stop
    running = false;
    btn.classList.remove("running");
    const finalList = Array.from(usernames).sort((a,b)=>a.localeCompare(b));
    cok(`Stopped by user. Final count: ${finalList.length}`);
    btn.textContent = `✅ ${finalList.length} usernames (click to run again)`;

    if (stopping && CFG.downloadOnManualStop) {
      const text = format(finalList);
      const name = withExt(CFG.downloadFilename);
      clog(`Downloading ${name} (${finalList.length} items)…`);
      download(name, text,
        CFG.downloadFormat === "json" ? "application/json" :
        CFG.downloadFormat === "csv"  ? "text/csv" : "text/plain");
    }
    stopping = false;
  }
})();
