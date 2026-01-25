// ==UserScript==
// @name         IG Following Hover Scraper (modal -> CSV) v1.3
// @namespace    https://tampermonkey.net/
// @version      1.3.0
// @description  Scrape posts/followers/following from hover cards in Following modal and export CSV.
// @match        https://www.instagram.com/YOUR_USERNAME/following/*
// @match        https://www.instagram.com/YOUR_USERNAME/following/
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  "use strict";

  const CONFIG = {
    batchSize: 12,
    hoverTimeoutMs: 6000,
    minDelayMs: 450,
    maxDelayMs: 900,
    scrollStepFactor: 0.85,

    // New: never auto-stop on slow loading
    stallWarnEvery: 6,          // log a message every N stall loops
    baseStallWaitMs: 1200,      // starting wait when IG is slow
    stallWaitGrowthMs: 800,     // add this per stall loop
    maxStallWaitMs: 20000,      // cap the wait
    bottomJiggleEvery: 10       // every N stall loops, jiggle scroll to trigger loading
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const now = () => new Date().toISOString().replace("T", " ").replace("Z", "");
  function log(msg) { UI.appendLog(`[${now()}] ${msg}`); }

  function parseCompactNumber(raw) {
    if (raw == null) return null;
    const s0 = String(raw).trim();
    if (!s0) return null;
    const s = s0.replace(/,/g, "").replace(/\s+/g, "").toLowerCase();
    const m = s.match(/^(\d+(\.\d+)?)([kmb])?$/i);
    if (!m) return null;
    const num = Number(m[1]);
    if (!Number.isFinite(num)) return null;
    const suf = (m[3] || "").toLowerCase();
    const mult = suf === "k" ? 1e3 : suf === "m" ? 1e6 : suf === "b" ? 1e9 : 1;
    return Math.round(num * mult);
  }

  function escapeCsv(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function extractUsernameFromHref(href) {
    if (!href) return null;
    const m = String(href).trim().match(/^\/([A-Za-z0-9._]+)\/?$/);
    if (!m) return null;
    const u = m[1];
    const bad = new Set([
      "explore","accounts","reels","reel","p","stories","direct","tv","about",
      "privacy","terms","developers","api","oauth","challenge"
    ]);
    if (bad.has(u.toLowerCase())) return null;
    return u;
  }

  function findFollowingCountAnchor() {
    const anchors = Array.from(document.querySelectorAll('a[href$="/following/"], a[href$="/following"]'));
    return anchors.find(a => /following/i.test((a.innerText || "").trim())) || null;
  }

  function readTotalFollowing() {
    const a = findFollowingCountAnchor();
    if (!a) return null;

    const spanNum = a.querySelector("span.html-span");
    if (spanNum && spanNum.textContent) {
      const n = parseCompactNumber(spanNum.textContent.trim());
      if (n != null) return n;
    }

    const text = (a.innerText || "").replace(/\s+/g, " ").trim();
    const m = text.match(/([\d.,]+)\s+following/i);
    if (!m) return null;
    return parseCompactNumber(m[1]);
  }

  function findFollowingDialog() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const withSearch = dialogs.find(d =>
      d.querySelector('input[placeholder="Search"]') && /Following/i.test(d.innerText || "")
    );
    if (withSearch) return withSearch;
    return dialogs.find(d => /Following/i.test(d.innerText || "")) || null;
  }

  async function waitFor(fn, { timeoutMs = 10000, pollMs = 200 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = fn();
        if (v) return v;
      } catch {}
      await sleep(pollMs);
    }
    return null;
  }

  function getUserLinks(dialog) {
    if (!dialog) return [];
    const anchors = Array.from(dialog.querySelectorAll('a[href^="/"]'));
    const out = [];
    const seen = new Set();

    for (const a of anchors) {
      const href = a.getAttribute("href");
      const username = extractUsernameFromHref(href);
      if (!username) continue;

      const txt = (a.textContent || "").trim();
      if (!txt) continue;

      if (!txt.toLowerCase().includes(username.toLowerCase())) continue;

      const key = username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ a, username, profileUrl: new URL(href, location.origin).toString() });
    }
    return out;
  }

  function isScrollable(el) {
    if (!el) return false;
    const st = getComputedStyle(el);
    const oy = (st.overflowY || "").toLowerCase();
    const okOverflow = oy === "auto" || oy === "scroll";
    return okOverflow && el.scrollHeight > el.clientHeight + 40;
  }

  function findScrollableAncestor(startEl, stopEl) {
    let el = startEl;
    for (let i = 0; i < 25 && el && el !== stopEl; i++) {
      if (isScrollable(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function isModalLoading(dialog) {
    if (!dialog) return false;
    // seen in your HTML: data-visualcompletion="loading-state" role="progressbar"
    return !!dialog.querySelector('[role="progressbar"], [data-visualcompletion="loading-state"], svg[aria-label="Loading..."]');
  }

  function findHoverCard() {
    const candidates = [
      ...Array.from(document.querySelectorAll('div[role="tooltip"]')),
      ...Array.from(document.querySelectorAll('div[style*="transform"]'))
    ];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const d = candidates[i];
      const txt = (d.innerText || "").toLowerCase();
      if (txt.includes("followers") && txt.includes("following") && (txt.includes("posts") || txt.includes("post"))) {
        return d;
      }
    }
    return null;
  }

  function parseCountsFromHoverCard(card) {
    if (!card) return { posts: null, followers: null, following: null };
    const text = (card.innerText || "").replace(/\s+/g, " ").trim();

    const postsM = text.match(/([\d.,]+(?:\.\d+)?[kmb]?)\s*post(s)?/i);
    const follM  = text.match(/([\d.,]+(?:\.\d+)?[kmb]?)\s*followers/i);
    const wingM  = text.match(/([\d.,]+(?:\.\d+)?[kmb]?)\s*following/i);

    return {
      posts: postsM ? parseCompactNumber(postsM[1]) : null,
      followers: follM ? parseCompactNumber(follM[1]) : null,
      following: wingM ? parseCompactNumber(wingM[1]) : null
    };
  }

  function findRowContainerFromUsernameAnchor(a) {
    const href = a.getAttribute("href");
    let el = a;
    for (let i = 0; i < 10 && el; i++) {
      if (el.querySelector && href) {
        const sameLink = el.querySelector(`a[href="${CSS.escape(href)}"]`);
        const btn = el.querySelector("button");
        const btnTxt = (btn && (btn.innerText || "").toLowerCase()) || "";
        if (sameLink && (btnTxt.includes("follow") || btnTxt.includes("following"))) return el;
      }
      el = el.parentElement;
    }
    return a.parentElement || a;
  }

  function fireMouse(el, type) {
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2)
    };
    try {
      el.dispatchEvent(new MouseEvent(type, opts));
    } catch {
      el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, composed: true }));
    }
  }

  async function hoverAndReadCounts(usernameAnchor, { timeoutMs = 6000 } = {}) {
    const row = findRowContainerFromUsernameAnchor(usernameAnchor);
    const img = row.querySelector('img[alt*="profile picture"]');
    const target = img || usernameAnchor;

    try { target.scrollIntoView({ block: "center", inline: "nearest" }); } catch {}

    fireMouse(target, "mouseover");
    fireMouse(target, "mousemove");

    const card = await waitFor(() => findHoverCard(), { timeoutMs, pollMs: 150 });
    if (!card) {
      fireMouse(target, "mouseout");
      return { posts: null, followers: null, following: null, ok: false };
    }

    const counts = parseCountsFromHoverCard(card);
    fireMouse(target, "mouseout");
    return { ...counts, ok: true };
  }

  const STATE_KEY = "IG_FOLLOWING_SCRAPER_STATE_V13";

  const Runner = {
    running: false,
    paused: false,
    stopRequested: false,

    total: null,
    processed: new Set(),
    results: [],
    scrollEl: null,

    saveState() {
      GM_setValue(STATE_KEY, JSON.stringify({
        total: this.total,
        processed: Array.from(this.processed),
        results: this.results
      }));
    },

    loadState() {
      try {
        const raw = GM_getValue(STATE_KEY, "");
        if (!raw) return false;
        const p = JSON.parse(raw);
        this.total = p.total ?? null;
        this.processed = new Set(p.processed || []);
        this.results = Array.isArray(p.results) ? p.results : [];
        return true;
      } catch {
        return false;
      }
    },

    clearState() { GM_setValue(STATE_KEY, ""); },

    async ensureModalOpen() {
      let dlg = findFollowingDialog();
      if (dlg) return dlg;

      const a = findFollowingCountAnchor();
      if (!a) throw new Error("Could not find Following link/anchor.");
      log("Opening Following modal...");
      a.click();

      dlg = await waitFor(() => findFollowingDialog(), { timeoutMs: 12000, pollMs: 200 });
      if (!dlg) throw new Error("Following modal did not appear.");
      return dlg;
    },

    stop() {
      this.stopRequested = true;
      this.paused = false;
      UI.setStatus("Stopping...");
    },

    togglePause() {
      this.paused = !this.paused;
      UI.setPauseLabel(this.paused ? "Resume" : "Pause");
      UI.setStatus(this.paused ? "Paused" : "Running");
    },

    exportCsv() {
      const map = new Map();
      for (const r of this.results) {
        const prev = map.get(r.username);
        if (!prev) map.set(r.username, r);
        else if (!prev.ok && r.ok) map.set(r.username, r);
      }
      const rows = Array.from(map.values());

      const header = ["username", "profile_url", "posts", "followers", "following"];
      const lines = [header.join(",")];

      for (const r of rows) {
        lines.push([
          escapeCsv(r.username),
          escapeCsv(r.profile_url),
          escapeCsv(r.posts ?? ""),
          escapeCsv(r.followers ?? ""),
          escapeCsv(r.following ?? "")
        ].join(","));
      }

      const csv = lines.join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `instagram_following_${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      log(`CSV exported (${rows.length} rows).`);
    },

    async run() {
      this.running = true;
      this.stopRequested = false;
      UI.setStatus("Running");
      UI.setButtons({ start: false, pause: true, stop: true, export: true });

      const total = readTotalFollowing();
      if (total) {
        this.total = total;
        log(`Total following detected: ${total}`);
      } else {
        log("Could not read total following count. Will run indefinitely until manual Stop.");
      }

      const dlg = await this.ensureModalOpen();

      const ready = await waitFor(() => {
        const list = getUserLinks(dlg);
        return list.length ? list : null;
      }, { timeoutMs: 20000, pollMs: 250 });

      if (!ready) throw new Error("No user rows found in modal (still loading or selectors changed).");

      this.scrollEl = findScrollableAncestor(ready[0].a, dlg) || null;
      if (!this.scrollEl) {
        const divs = Array.from(dlg.querySelectorAll("div")).filter(isScrollable);
        this.scrollEl = divs.sort((a,b) => (b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0] || null;
      }
      if (!this.scrollEl) throw new Error("Could not find modal scroll container.");

      log(`Modal ready. Found scroll container (clientHeight=${this.scrollEl.clientHeight}).`);

      let stallLoops = 0;
      let lastProcessed = this.processed.size;
      let lastDomUsers = getUserLinks(dlg).length;

      while (!this.stopRequested) {
        while (this.paused && !this.stopRequested) {
          UI.setStatus("Paused");
          await sleep(250);
        }
        if (this.stopRequested) break;
        UI.setStatus("Running");

        if (this.total && this.processed.size >= this.total) {
          log("Reached total following snapshot. Finishing...");
          break;
        }

        const links = getUserLinks(dlg);
        const todo = links.filter(u => !this.processed.has(u.username));
        const batch = todo.slice(0, CONFIG.batchSize);

        if (batch.length) {
          stallLoops = 0; // we have fresh work
        }

        for (const u of batch) {
          if (this.stopRequested) break;
          while (this.paused && !this.stopRequested) await sleep(250);

          this.processed.add(u.username);
          UI.setProgress(this.processed.size, this.total);

          log(`Hovering: ${u.username}`);

          let posts=null, followers=null, following=null, ok=false;
          try {
            const res = await hoverAndReadCounts(u.a, { timeoutMs: CONFIG.hoverTimeoutMs });
            posts = res.posts; followers = res.followers; following = res.following; ok = res.ok;
          } catch (e) {
            log(`Hover error for ${u.username}: ${e?.message || e}`);
          }

          this.results.push({
            username: u.username,
            profile_url: u.profileUrl,
            posts, followers, following, ok
          });

          UI.setLastUser(u.username, posts, followers, following, ok);
          this.saveState();

          await sleep(jitter(CONFIG.minDelayMs, CONFIG.maxDelayMs));
        }

        // Scroll for more users
        const step = Math.max(200, Math.floor(this.scrollEl.clientHeight * CONFIG.scrollStepFactor));
        this.scrollEl.scrollTop = this.scrollEl.scrollTop + step;

        // Wait a bit (and longer if IG shows a spinner)
        let baseWait = jitter(900, 1400);
        await sleep(baseWait);

        // Update stall logic: NEVER stop automatically, just back off and keep trying
        const domUsersNow = getUserLinks(dlg).length;
        const processedNow = this.processed.size;

        const noProgress = (processedNow === lastProcessed);
        const noNewDomUsers = (domUsersNow === lastDomUsers);

        if (noProgress && (todo.length === 0 || noNewDomUsers)) {
          stallLoops += 1;

          // If modal is still loading, just wait more (don’t count as “failure”)
          const loading = isModalLoading(dlg);

          let extraWait = Math.min(
            CONFIG.maxStallWaitMs,
            CONFIG.baseStallWaitMs + (stallLoops * CONFIG.stallWaitGrowthMs)
          );

          if (loading) extraWait = Math.min(CONFIG.maxStallWaitMs, extraWait + 2500);

          if (stallLoops % CONFIG.stallWarnEvery === 0) {
            log(`Waiting for more users to load... (stallLoops=${stallLoops}, wait=${Math.round(extraWait/1000)}s${loading ? ", loading..." : ""})`);
          }

          // Occasionally jiggle to trigger load
          if (stallLoops % CONFIG.bottomJiggleEvery === 0) {
            // jump to bottom, then slightly up, then bottom again
            this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
            await sleep(700);
            this.scrollEl.scrollTop = Math.max(0, this.scrollEl.scrollTop - Math.floor(this.scrollEl.clientHeight * 0.6));
            await sleep(700);
            this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
            await sleep(700);
          }

          await sleep(extraWait);
        } else {
          stallLoops = 0;
        }

        lastProcessed = processedNow;
        lastDomUsers = domUsersNow;
      }

      this.running = false;
      this.paused = false;

      UI.setStatus("Done");
      UI.setButtons({ start: true, pause: false, stop: false, export: true });
      UI.setProgress(this.processed.size, this.total);

      log(`Finished. Rows: ${this.results.length}, unique users: ${this.processed.size}`);
      log("Click Export CSV to download.");
    }
  };

  // UI
  GM_addStyle(`
    #igfs_panel {
      position: fixed; right: 14px; bottom: 14px; z-index: 999999;
      width: 340px; background: rgba(20,20,22,0.92); color: #fff;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;
      padding: 10px 10px 8px; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35); backdrop-filter: blur(8px);
    }
    #igfs_panel * { box-sizing: border-box; }
    #igfs_title { font-weight: 700; font-size: 14px; display:flex; align-items:center; justify-content:space-between; }
    #igfs_status { font-size: 12px; opacity: 0.9; margin-top: 2px; }
    #igfs_row { display:flex; gap: 8px; margin-top: 8px; }
    .igfs_btn {
      flex: 1; border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06); color: #fff;
      padding: 8px 10px; border-radius: 10px; cursor: pointer;
      font-weight: 600; font-size: 12px;
    }
    .igfs_btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #igfs_prog { margin-top: 8px; background: rgba(255,255,255,0.08); border-radius: 8px; height: 10px; overflow: hidden; border: 1px solid rgba(255,255,255,0.12); }
    #igfs_prog > div { height: 100%; width: 0%; background: rgba(255,255,255,0.35); transition: width 120ms linear; }
    #igfs_meta { margin-top: 8px; font-size: 12px; line-height: 1.35; opacity: 0.95; }
    #igfs_log {
      margin-top: 8px; height: 120px; overflow: auto; font-size: 11px; line-height: 1.3;
      padding: 8px; border-radius: 10px; background: rgba(0,0,0,0.25);
      border: 1px solid rgba(255,255,255,0.10); white-space: pre-wrap;
    }
  `);

  const UI = (() => {
    const panel = document.createElement("div");
    panel.id = "igfs_panel";
    panel.innerHTML = `
      <div id="igfs_title">
        <div>IG Following Scraper</div>
        <div style="font-size:11px;opacity:.75">v1.3</div>
      </div>
      <div id="igfs_status">Status: <b id="igfs_status_val">Idle</b></div>

      <div id="igfs_row">
        <button class="igfs_btn" id="igfs_start">Start</button>
        <button class="igfs_btn" id="igfs_pause" disabled>Pause</button>
        <button class="igfs_btn" id="igfs_stop" disabled>Stop</button>
      </div>

      <div id="igfs_row">
        <button class="igfs_btn" id="igfs_export">Export CSV</button>
        <button class="igfs_btn" id="igfs_clear">Clear State</button>
      </div>

      <div id="igfs_prog"><div></div></div>
      <div id="igfs_meta">
        <div>Progress: <b id="igfs_prog_txt">0</b></div>
        <div>Last: <b id="igfs_last_user">—</b></div>
        <div>Counts: posts=<b id="igfs_last_posts">—</b>, followers=<b id="igfs_last_followers">—</b>, following=<b id="igfs_last_following">—</b></div>
      </div>

      <div id="igfs_log"></div>
    `;

    document.documentElement.appendChild(panel);
    const $ = (sel) => panel.querySelector(sel);

    const statusEl = $("#igfs_status_val");
    const progBar = $("#igfs_prog > div");
    const progTxt = $("#igfs_prog_txt");
    const lastUser = $("#igfs_last_user");
    const lastPosts = $("#igfs_last_posts");
    const lastFollowers = $("#igfs_last_followers");
    const lastFollowing = $("#igfs_last_following");
    const logBox = $("#igfs_log");

    const btnStart = $("#igfs_start");
    const btnPause = $("#igfs_pause");
    const btnStop = $("#igfs_stop");
    const btnExport = $("#igfs_export");
    const btnClear = $("#igfs_clear");

    btnStart.addEventListener("click", async () => {
      try {
        if (Runner.running) return;
        if (Runner.loadState()) log(`Loaded saved state: ${Runner.processed.size} users.`);
        Runner.paused = false;
        setPauseLabel("Pause");
        Runner.run().catch((e) => {
          log(`ERROR: ${e?.message || e}`);
          Runner.running = false;
          setStatus("Error");
          setButtons({ start: true, pause: false, stop: false, export: true });
        });
      } catch (e) {
        log(`Start failed: ${e?.message || e}`);
      }
    });

    btnPause.addEventListener("click", () => {
      if (!Runner.running) return;
      Runner.togglePause();
    });

    btnStop.addEventListener("click", () => {
      if (!Runner.running) return;
      Runner.stop();
    });

    btnExport.addEventListener("click", () => Runner.exportCsv());

    btnClear.addEventListener("click", () => {
      Runner.clearState();
      Runner.total = null;
      Runner.processed = new Set();
      Runner.results = [];
      setProgress(0, null);
      lastUser.textContent = "—";
      lastPosts.textContent = "—";
      lastFollowers.textContent = "—";
      lastFollowing.textContent = "—";
      appendLog(`[${now()}] Cleared saved state.`);
    });

    function setButtons({ start, pause, stop, export: exp }) {
      btnStart.disabled = !start;
      btnPause.disabled = !pause;
      btnStop.disabled = !stop;
      btnExport.disabled = !exp;
    }

    function setPauseLabel(txt) { btnPause.textContent = txt; }
    function setStatus(txt) { statusEl.textContent = txt; }

    function setProgress(done, total) {
      const t = total || Runner.total || null;
      const pct = t ? Math.min(100, Math.round((done / t) * 100)) : 0;
      progBar.style.width = `${pct}%`;
      progTxt.textContent = t ? `${done}/${t} (${pct}%)` : `${done} (total unknown)`;
    }

    function setLastUser(u, posts, followers, following, ok) {
      lastUser.textContent = ok ? u : `${u} (no hover data)`;
      lastPosts.textContent = posts ?? "—";
      lastFollowers.textContent = followers ?? "—";
      lastFollowing.textContent = following ?? "—";
    }

    function appendLog(line) {
      logBox.textContent += (logBox.textContent ? "\n" : "") + line;
      logBox.scrollTop = logBox.scrollHeight;
    }

    setButtons({ start: true, pause: false, stop: false, export: true });

    return { setButtons, setPauseLabel, setStatus, setProgress, setLastUser, appendLog };
  })();

  log("Ready. Open the following page and click Start.");
})();
