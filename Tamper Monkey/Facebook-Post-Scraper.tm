// ==UserScript==
// @name         Post Extractor Widget (FB: Date Range + CSV) - Robust + Debug
// @namespace    https://example.com/
// @version      0.5.0
// @description  Widget that extracts FB post permalink/text/image/date while scrolling; robust selectors; better stop logic for non-chronological feeds; built-in debug logs; downloads CSV.
// @match        *://www.facebook.com/search/top*
// @match        *://www.facebook.com/groups/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_download
// ==/UserScript==

(() => {
  "use strict";

  /********************
   * CONFIG
   ********************/
  const URL_REGEX = /\/(search\/top\b|groups\/)/i;

  // We only stop on "past end" when we see this many OLDER posts in a row
  const EXTRA_PAST_END_CONSECUTIVE = 12;

  // Also require that we haven’t seen any in-range posts for this many loops before stopping
  const LOOPS_WITHOUT_INRANGE_TO_STOP = 3;

  // Scroll behavior
  const SCROLL_WAIT_MS = 1400;
  const SCROLL_POLL_MS = 250;
  const SCROLL_POLL_MAX = 10; // polls per scroll wait
  const SCROLL_RETRY_MAX = 3; // attempts per loop

  // Stop if we can’t find any new posts for this many loops
  const STAGNATION_LIMIT = 10;

  // Max "See more" clicks per post
  const MAX_SEE_MORE_CLICKS_PER_POST = 2;

  // If FB refuses to expose dates in DOM, you'll still get results with blank dateIso.
  const KEEP_POSTS_WITH_UNKNOWN_DATE = true;

  /********************
   * GUARDS
   ********************/
  if (!URL_REGEX.test(location.href)) return;
  if (document.getElementById("tm-extract-widget")) return; // prevent double-inject

  /********************
   * STYLES
   ********************/
  const addStyle = (css) => {
    if (typeof GM_addStyle === "function") GM_addStyle(css);
    else {
      const s = document.createElement("style");
      s.textContent = css;
      document.head.appendChild(s);
    }
  };

  addStyle(`
    #tm-extract-widget {
      position: fixed;
      right: 16px;
      bottom: 16px;
      width: 380px;
      z-index: 999999;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background: rgba(20,20,20,0.95);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.4);
      padding: 12px;
    }
    #tm-extract-widget h3{
      margin: 0 0 10px 0;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }
    #tm-extract-widget label{
      display: block;
      font-size: 12px;
      margin: 8px 0 4px;
      opacity: 0.9;
    }
    #tm-extract-widget input[type="date"]{
      width: 100%;
      padding: 8px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.15);
      background: rgba(255,255,255,0.07);
      color: #fff;
      outline: none;
    }
    #tm-extract-widget .row{
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    #tm-extract-widget button{
      flex: 1;
      padding: 9px 10px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.15);
      background: rgba(255,255,255,0.10);
      color: #fff;
      cursor: pointer;
      font-weight: 650;
      font-size: 13px;
    }
    #tm-extract-widget button:hover{ background: rgba(255,255,255,0.16); }
    #tm-extract-widget button:disabled{
      cursor: not-allowed;
      opacity: 0.5;
    }
    #tm-extract-widget .status{
      margin-top: 10px;
      font-size: 12px;
      line-height: 1.35;
      opacity: 0.95;
      white-space: pre-wrap;
    }
    #tm-extract-widget .mini{
      opacity: 0.75;
      font-size: 11px;
      margin-top: 6px;
    }
    #tm-extract-widget details{
      margin-top: 8px;
      border-top: 1px solid rgba(255,255,255,0.12);
      padding-top: 8px;
    }
    #tm-extract-widget summary{
      cursor: pointer;
      font-size: 12px;
      opacity: 0.9;
      user-select: none;
    }
    #tm-logbox{
      margin-top: 8px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      padding: 8px;
      max-height: 180px;
      overflow: auto;
      font-size: 11px;
      line-height: 1.35;
      white-space: pre-wrap;
    }
    #tm-debug-row{
      display:flex;
      gap: 8px;
      align-items:center;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    #tm-debug-row label{
      margin: 0;
      display:flex;
      gap: 6px;
      align-items:center;
      font-size: 11px;
      opacity: 0.9;
    }
    #tm-debug-row button{
      flex: unset;
      padding: 6px 8px;
      font-size: 11px;
      border-radius: 8px;
    }
  `);

  /********************
   * WIDGET UI
   ********************/
  const widget = document.createElement("div");
  widget.id = "tm-extract-widget";
  widget.innerHTML = `
    <h3>Post Extractor</h3>

    <label>Start date (default: today)</label>
    <input id="tmStartDate" type="date"/>

    <label>End date (default: today - 7 days)</label>
    <input id="tmEndDate" type="date"/>

    <div class="row">
      <button id="tmStartBtn">Start extraction</button>
      <button id="tmDownloadBtn" disabled>Download results</button>
    </div>

    <div class="status" id="tmStatus">Idle.</div>
    <div class="mini">Tip: Switch group feed to “Most recent”. Keep the tab active.</div>

    <details>
      <summary>Debug</summary>
      <div id="tm-debug-row">
        <label><input id="tmConsoleLogs" type="checkbox"/> Console logs</label>
        <button id="tmCopyLogsBtn" type="button">Copy logs</button>
        <button id="tmClearLogsBtn" type="button">Clear logs</button>
      </div>
      <div id="tm-logbox"></div>
    </details>
  `;
  document.body.appendChild(widget);

  const $startDate = widget.querySelector("#tmStartDate");
  const $endDate = widget.querySelector("#tmEndDate");
  const $startBtn = widget.querySelector("#tmStartBtn");
  const $downloadBtn = widget.querySelector("#tmDownloadBtn");
  const $status = widget.querySelector("#tmStatus");
  const $logbox = widget.querySelector("#tm-logbox");
  const $consoleLogs = widget.querySelector("#tmConsoleLogs");
  const $copyLogsBtn = widget.querySelector("#tmCopyLogsBtn");
  const $clearLogsBtn = widget.querySelector("#tmClearLogsBtn");

  const pad2 = (n) => String(n).padStart(2, "0");
  const toYMD = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);

  $startDate.value = toYMD(today);
  $endDate.value = toYMD(weekAgo);

  /********************
   * STATE
   ********************/
  const state = {
    running: false,
    paused: false,
    results: [],
    seenKeys: new Set(),

    stagnation: 0,
    loops: 0,

    // date + stopping logic
    dtParsedTotal: 0,
    consecutivePastEnd: 0,
    lastInRangeLoop: 0,

    lastDateRaw: "",
    lastDateIso: "",

    // debug
    logs: [],
    maxLogs: 200,
    lastCandidateCount: 0,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setStatus(msg) { $status.textContent = msg; }
  function enableDownloadIfAllowed() {
    $downloadBtn.disabled = !(state.paused || (!state.running && state.results.length > 0));
  }

  function nowStamp() {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function safeJson(o) {
    try { return JSON.stringify(o); } catch { return String(o); }
  }

  function dbg(msg, obj) {
    const line = obj ? `${nowStamp()} ${msg} ${safeJson(obj)}` : `${nowStamp()} ${msg}`;
    state.logs.push(line);
    if (state.logs.length > state.maxLogs) state.logs.shift();
    $logbox.textContent = state.logs.join("\n");
    if ($consoleLogs.checked) console.log("[PostExtractor]", msg, obj ?? "");
  }

  /********************
   * DATE / RANGE
   ********************/
  function parseYMD(ymd, endOfDay = false) {
    if (!ymd) return null;
    const [y, m, d] = ymd.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(
      y, m - 1, d,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0
    );
  }

  function getBoundaries() {
    const a = parseYMD($startDate.value, true);
    const b = parseYMD($endDate.value, false);
    const lowerBound = new Date(Math.min(a.getTime(), b.getTime()));
    const upperBound = new Date(Math.max(a.getTime(), b.getTime()));
    return { lowerBound, upperBound };
  }

  function normalizeDigits(str) {
    if (!str) return str;
    const bn = "০১২৩৪৫৬৭৮৯";
    const ar = "٠١٢٣٤٥٦٧٨٩";
    return str.replace(/[০-৯]/g, (d) => String(bn.indexOf(d)))
              .replace(/[٠-٩]/g, (d) => String(ar.indexOf(d)));
  }

  function cleanTimeText(text) {
    if (!text) return "";
    let t = normalizeDigits(text);
    t = t.replace(/\u00A0/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/[•·•—–\-_:|]+/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  }

  function parseRelative(text) {
    if (!text) return null;
    const raw = cleanTimeText(text);
    if (!raw) return null;

    if (/^just\s*now$/i.test(raw)) return new Date();
    if (/^yesterday\b/i.test(raw)) {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d;
    }

    const compact = raw.replace(/[^\p{L}\p{N}]+/gu, "");

    let m = compact.match(/^(\d+)(s|m|h|d|w)$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      const d = new Date();
      if (unit === "s") d.setSeconds(d.getSeconds() - num);
      if (unit === "m") d.setMinutes(d.getMinutes() - num);
      if (unit === "h") d.setHours(d.getHours() - num);
      if (unit === "d") d.setDate(d.getDate() - num);
      if (unit === "w") d.setDate(d.getDate() - num * 7);
      return d;
    }

    m = compact.match(/^(\d+)(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|week|weeks)$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      const d = new Date();
      if (unit.startsWith("sec")) d.setSeconds(d.getSeconds() - num);
      else if (unit.startsWith("min")) d.setMinutes(d.getMinutes() - num);
      else if (unit.startsWith("hr") || unit.startsWith("hour")) d.setHours(d.getHours() - num);
      else if (unit.startsWith("day")) d.setDate(d.getDate() - num);
      else if (unit.startsWith("week")) d.setDate(d.getDate() - num * 7);
      return d;
    }

    const loose = raw.replace(/\s+/g, "");
    const mLoose = loose.match(/(\d+).{0,6}?([smhdw])/i);
    if (mLoose) {
      const num = parseInt(mLoose[1], 10);
      const unit = mLoose[2].toLowerCase();
      const d = new Date();
      if (unit === "s") d.setSeconds(d.getSeconds() - num);
      if (unit === "m") d.setMinutes(d.getMinutes() - num);
      if (unit === "h") d.setHours(d.getHours() - num);
      if (unit === "d") d.setDate(d.getDate() - num);
      if (unit === "w") d.setDate(d.getDate() - num * 7);
      return d;
    }

    return null;
  }

  function tryParseAbsolute(text) {
    if (!text) return null;
    const cleaned = cleanTimeText(text).replace(/\bat\b/gi, " ").replace(/\s+/g, " ").trim();
    const ts = Date.parse(cleaned);
    if (!Number.isNaN(ts)) return new Date(ts);
    return null;
  }

  function getPostDateFromContainer(container) {
    const candidates = [];

    // 1) abbr/title (classic)
    const abbr = container.querySelector("abbr[title]");
    if (abbr?.getAttribute("title")) candidates.push(abbr.getAttribute("title"));

    // 2) data-utime (rare)
    const ut = container.querySelector("[data-utime]");
    if (ut?.getAttribute("data-utime")) {
      const v = parseInt(ut.getAttribute("data-utime"), 10);
      if (!Number.isNaN(v)) return new Date(v * 1000);
    }

    // 3) title / tooltip (skip comment/reply)
    container.querySelectorAll("[title]").forEach((el) => {
      const t = el.getAttribute("title");
      if (!t) return;
      if (/comment by|reply by/i.test(t)) return;
      if (/ago|yesterday|20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(t)) candidates.push(t);
    });

    container.querySelectorAll("[data-tooltip-content]").forEach((el) => {
      const t = el.getAttribute("data-tooltip-content");
      if (!t) return;
      if (/comment by|reply by/i.test(t)) return;
      candidates.push(t);
    });

    // 4) aria-label (skip comment/reply)
    container.querySelectorAll("[aria-label]").forEach((el) => {
      const a = el.getAttribute("aria-label");
      if (!a) return;
      if (/comment by|reply by/i.test(a)) return;
      if (/ago|yesterday|minutes|hours|days|weeks|20\d{2}/i.test(a)) candidates.push(a);
    });

    // 5) Short visible timestamp: ONLY near the top of the post (avoid comment "59m", "49m", etc)
    const cRect = container.getBoundingClientRect();
    const topBandPx = 260;

    const shortish = [...container.querySelectorAll("a, span, b")]
      .map((el) => {
        const r = el.getBoundingClientRect();
        const t = (el.textContent || "").trim();
        return { t, dy: r.top - cRect.top };
      })
      .filter(({ t, dy }) => t && t.length <= 30 && dy >= -20 && dy <= topBandPx);

    // prefer ones that contain digits
    shortish.sort((x, y) => (/\d/.test(y.t) ? 1 : 0) - (/\d/.test(x.t) ? 1 : 0));
    candidates.push(...shortish.slice(0, 40).map((x) => x.t));

    for (const c of candidates) {
      const rel = parseRelative(c);
      if (rel) { state.lastDateRaw = String(c); return rel; }
      const abs = tryParseAbsolute(c);
      if (abs) { state.lastDateRaw = String(c); return abs; }
    }

    return null;
  }

  /********************
   * URL / POST ID HELPERS
   ********************/
  function extractPostIdFromUrl(absUrl) {
    try {
      const u = new URL(absUrl, location.origin);
      const m1 = u.pathname.match(/\/posts\/(\d+)/i);
      if (m1) return m1[1];

      const story = u.searchParams.get("story_fbid") || u.searchParams.get("fbid");
      if (story && /^\d+$/.test(story)) return story;

      const m2 = u.href.match(/story_fbid=(\d+)/i);
      if (m2) return m2[1];

      return null;
    } catch {
      return null;
    }
  }

  function normalizePostUrl(absUrl) {
    try {
      const u = new URL(absUrl, location.origin);
      u.hash = "";

      const postId = extractPostIdFromUrl(u.href);
      if (!postId) return `${u.origin}${u.pathname}`;

      if (/\/posts\/\d+/i.test(u.pathname)) return `${u.origin}${u.pathname}`;

      const keep = new URL(u.origin + u.pathname);
      const story = u.searchParams.get("story_fbid") || u.searchParams.get("fbid");
      const id = u.searchParams.get("id");
      if (story) keep.searchParams.set("story_fbid", story);
      if (id) keep.searchParams.set("id", id);
      return keep.toString();
    } catch {
      return absUrl;
    }
  }

  function makeKeyFromUrl(absUrl) {
    const postId = extractPostIdFromUrl(absUrl);
    if (postId) return `post:${postId}`;
    return normalizePostUrl(absUrl);
  }

  /********************
   * POST DISCOVERY (NO FB CLASSNAMES)
   ********************/
  function findCandidatePostAnchors() {
    const selectors = [
      'a[href*="/groups/"][href*="/posts/"]',
      'a[href*="/posts/"]',
      'a[href*="permalink.php?"]',
      'a[href*="story_fbid="]',
      'a[href*="story.php?story_fbid="]',
    ];

    const all = new Set();
    for (const sel of selectors) document.querySelectorAll(sel).forEach((a) => all.add(a));

    return [...all].filter((a) => {
      const href = a.getAttribute("href");
      if (!href) return false;

      let u;
      try { u = new URL(href, location.origin); } catch { return false; }

      // ❗CRITICAL: skip comment/reply permalinks
      if (u.searchParams.has("comment_id") || u.searchParams.has("reply_comment_id")) return false;

      // ignore group member/profile links
      if (/\/groups\/[^/]+\/user\//i.test(u.pathname)) return false;

      // ignore obvious comment/reply containers (English UI; harmless if not present)
      const aria = a.closest("[aria-label]");
      const ariaTxt = aria?.getAttribute?.("aria-label") || "";
      if (/comment by|reply by/i.test(ariaTxt)) return false;

      // only keep ones that actually contain a post id
      return !!extractPostIdFromUrl(u.href);
    });
  }

  function isPostContainer(el) {
    if (!el) return false;

    // Most reliable: post message node
    if (el.querySelector?.('[data-ad-rendering-role="story_message"], [data-ad-preview="message"]')) return true;

    // Backup: post action menu (English)
    if (el.querySelector?.('[aria-label="Actions for this post"], [aria-label*="Actions for this post"]')) return true;

    return false;
  }

  function resolvePostContainerFromAnchor(a) {
    // Start from nearest article (could be a comment), then climb up until we find the real post article.
    let el = a.closest('div[role="article"]') || a;

    for (let i = 0; i < 25 && el; i++) {
      if (el.getAttribute?.("role") === "article" && isPostContainer(el)) return el;
      el = el.parentElement;
    }

    // Fallback: walk up looking for story_message
    el = a;
    for (let i = 0; i < 25 && el; i++) {
      if (el.querySelector?.('[data-ad-rendering-role="story_message"], [data-ad-preview="message"]')) return el;
      el = el.parentElement;
    }

    return null;
  }

  function collectVisiblePostCandidates() {
    const anchors = findCandidatePostAnchors();

    const map = new Map(); // key -> { key, link, container }
    for (const a of anchors) {
      const href = a.getAttribute("href");
      if (!href) continue;

      let abs;
      try { abs = new URL(href, location.origin).href; } catch { continue; }

      const key = makeKeyFromUrl(abs);
      if (map.has(key)) continue;

      const container = resolvePostContainerFromAnchor(a);
      if (!container) continue;
      if (!isPostContainer(container)) continue;

      const link = normalizePostUrl(abs);
      map.set(key, { key, link, container });
    }

    const arr = [...map.values()];
    arr.sort((x, y) => x.container.getBoundingClientRect().top - y.container.getBoundingClientRect().top);
    return arr;
  }

  /********************
   * CONTENT EXTRACTION
   ********************/
  function isPinnedOrFeatured(container) {
    const t = (container.innerText || "").toLowerCase();
    return t.includes("pinned") || t.includes("featured") || t.includes("announcement");
  }

  function clickSeeMoreIfPresent(container) {
    const scope =
      container.querySelector('[data-ad-rendering-role="story_message"]') ||
      container.querySelector('[data-ad-preview="message"]') ||
      container;

    const seeMoreRegex = /^(see more|more|আরও দেখুন|আরও|voir plus|ver más)$/i;
    const btns = [...scope.querySelectorAll('[role="button"], div[role="button"], span[role="button"]')];

    let clicks = 0;
    for (const b of btns) {
      if (clicks >= MAX_SEE_MORE_CLICKS_PER_POST) break;

      const t = (b.textContent || "").trim();
      if (!t) continue;

      const compact = t.replace(/\s+/g, " ").trim();
      if (!seeMoreRegex.test(compact)) continue;

      const r = b.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) continue;

      b.scrollIntoView({ block: "center" });
      try { b.click(); } catch {}
      clicks++;
    }
    return clicks;
  }

  function extractPostText(container) {
    const msg =
      container.querySelector('[data-ad-rendering-role="story_message"]') ||
      container.querySelector('[data-ad-preview="message"]');

    if (!msg) return "";

    // innerText can be empty with virtualization; textContent often still has content
    const t1 = (msg.innerText || "").trim();
    const t2 = (msg.textContent || "").trim();

    return (t1 || t2 || "")
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function extractFirstImageUrl(container) {
    const urls = [];

    // Normal <img>
    for (const img of container.querySelectorAll("img")) {
      const u = img.currentSrc || img.src || img.getAttribute("src") || img.getAttribute("data-src") || "";
      if (u) urls.push(u);
    }

    // SVG <image xlink:href>
    for (const im of container.querySelectorAll("image")) {
      const u = im.getAttribute("xlink:href") || im.getAttribute("href") || "";
      if (u) urls.push(u);
    }

    const filtered = urls.filter((src) => {
      if (!/^https?:\/\//i.test(src)) return false;
      if (src.startsWith("data:")) return false;

      // drop emoji + internal sprites
      if (/static\.xx\.fbcdn\.net\/images\/emoji\.php/i.test(src)) return false;
      if (/static\.xx\.fbcdn\.net\/rsrc\.php/i.test(src)) return false;

      // drop avatars/small thumbs
      if (/s\d{2}x\d{2}|p\d{2}x\d{2}|s50x50|p50x50|s32x32|p32x32|s24x24|p24x24/i.test(src)) return false;

      // drop profile image bucket
      if (/\/t39\.30808-1\//i.test(src)) return false;

      return true;
    });

    // Prefer actual post media bucket (-6)
    const preferred =
      filtered.find((u) => /\/t39\.30808-6\//i.test(u)) ||
      filtered.find((u) => /scontent\./i.test(u)) ||
      filtered[0];

    return preferred || "";
  }

  function toCsv(rows) {
    const header = ["postLink", "postDateIso", "postText", "postImageUrl"];
    const escape = (v) => {
      const s = (v ?? "").toString().replace(/\r?\n/g, "\\n");
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push([r.link, r.dateIso, r.text, r.imageUrl].map(escape).join(","));
    }
    return lines.join("\n");
  }

  function downloadCsv(filename, content) {
    if (typeof GM_download === "function") {
      const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      GM_download({
        url,
        name: filename,
        saveAs: true,
        onerror: () => URL.revokeObjectURL(url),
        onload: () => URL.revokeObjectURL(url),
      });
      return;
    }

    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /********************
   * SCROLLING (MORE ROBUST)
   ********************/
  function getBestScroller() {
    const candidates = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      ...document.querySelectorAll('[role="main"], [role="feed"], div[role="presentation"]')
    ].filter(Boolean);

    let best = document.scrollingElement || document.documentElement || document.body;
    let bestScore = -1;

    for (const el of candidates) {
      const sh = el.scrollHeight || 0;
      const ch = el.clientHeight || 0;
      const score = sh - ch;
      if (score > bestScore && score > 300) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  async function scrollAndWaitForGrowth(beforeCount) {
    const scroller = getBestScroller();
    const beforeTop = scroller.scrollTop || 0;
    const beforeHeight = scroller.scrollHeight || 0;

    try {
      scroller.scrollTo({ top: beforeHeight, behavior: "smooth" });
    } catch {
      window.scrollTo(0, document.body.scrollHeight);
    }

    dbg("scroll:start", { beforeCount, beforeTop, beforeHeight, scrollerTag: scroller.tagName });

    let grew = false;
    for (let i = 0; i < SCROLL_POLL_MAX; i++) {
      await sleep(SCROLL_POLL_MS);

      const nowCount = findCandidatePostAnchors().length;
      const nowHeight = scroller.scrollHeight || 0;

      if (nowCount > beforeCount || nowHeight > beforeHeight + 50) {
        dbg("scroll:grew", { i, nowCount, nowHeight });
        grew = true;
        break;
      }
    }

    if (!grew) {
      try { window.scrollBy(0, Math.floor(window.innerHeight * 0.9)); } catch {}
      await sleep(SCROLL_WAIT_MS);
      const nowCount2 = findCandidatePostAnchors().length;
      dbg("scroll:nudge", { nowCount2 });
      grew = nowCount2 > beforeCount;
    }

    return grew;
  }

  /********************
   * MAIN LOOP
   ********************/
  async function processVisiblePosts() {
    const { lowerBound, upperBound } = getBoundaries();
    const candidates = collectVisiblePostCandidates();

    let newlyProcessed = 0;
    let inRangeCount = 0;
    let dtParsedThisPass = 0;
    let unknownSaved = 0;
    let olderCounted = 0;

    for (const c of candidates) {
      if (!state.running || state.paused) break;
      if (state.seenKeys.has(c.key)) continue;

      clickSeeMoreIfPresent(c.container);
      await sleep(50);

      const dt = getPostDateFromContainer(c.container);
      const dateIso = dt ? dt.toISOString() : "";

      if (dt) {
        dtParsedThisPass++;
        state.dtParsedTotal++;
        state.lastDateIso = dateIso;
      }

      const inRange = dt ? (dt >= lowerBound && dt <= upperBound) : false;

      if (inRange) {
        const text = extractPostText(c.container);
        const imageUrl = extractFirstImageUrl(c.container);
        state.results.push({ link: c.link, dateIso, text, imageUrl });
        inRangeCount++;
        state.lastInRangeLoop = state.loops;
        state.consecutivePastEnd = 0;
      } else if (!dt && KEEP_POSTS_WITH_UNKNOWN_DATE) {
        const text = extractPostText(c.container);
        const imageUrl = extractFirstImageUrl(c.container);
        state.results.push({ link: c.link, dateIso: "", text, imageUrl });
        unknownSaved++;
      }

      state.seenKeys.add(c.key);
      newlyProcessed++;

      // Past-end logic: consecutive older posts (ignore pinned/featured)
      if (dt && dt < lowerBound && !isPinnedOrFeatured(c.container)) {
        state.consecutivePastEnd++;
        olderCounted++;
      } else if (dt) {
        state.consecutivePastEnd = 0;
      }
    }

    if (newlyProcessed === 0) state.stagnation++;
    else state.stagnation = 0;

    setStatus(
      `Running...\n` +
      `Results: ${state.results.length}\n` +
      `Processed unique posts: ${state.seenKeys.size}\n` +
      `Visible candidates: ${candidates.length}\n` +
      `Dates parsed (pass/total): ${dtParsedThisPass}/${state.dtParsedTotal}\n` +
      `In-range saved: ${inRangeCount}\n` +
      `Unknown-date saved: ${unknownSaved}\n` +
      `Consecutive past-end: ${state.consecutivePastEnd}/${EXTRA_PAST_END_CONSECUTIVE}\n` +
      `Loops since in-range: ${Math.max(0, state.loops - state.lastInRangeLoop)}/${LOOPS_WITHOUT_INRANGE_TO_STOP}\n` +
      `Stagnation: ${state.stagnation}/${STAGNATION_LIMIT}\n` +
      `Range: ${toYMD(lowerBound)} → ${toYMD(upperBound)}\n` +
      (state.lastDateIso ? `Last parsed date: ${state.lastDateIso}\n` : "")
    );

    dbg("process:pass", {
      loop: state.loops,
      candidates: candidates.length,
      newlyProcessed,
      inRangeCount,
      unknownSaved,
      dtParsedThisPass,
      consecutivePastEnd: state.consecutivePastEnd,
      olderCounted
    });

    return { newlyProcessed, candidatesCount: candidates.length };
  }

  function shouldStop() {
    if (state.stagnation >= STAGNATION_LIMIT) {
      dbg("stop:stagnation", { stagnation: state.stagnation });
      return true;
    }

    const loopsSinceInRange = state.loops - state.lastInRangeLoop;
    if (
      state.dtParsedTotal >= 5 &&
      state.consecutivePastEnd >= EXTRA_PAST_END_CONSECUTIVE &&
      loopsSinceInRange >= LOOPS_WITHOUT_INRANGE_TO_STOP
    ) {
      dbg("stop:past_end", {
        dtParsedTotal: state.dtParsedTotal,
        consecutivePastEnd: state.consecutivePastEnd,
        loopsSinceInRange
      });
      return true;
    }

    return false;
  }

  async function runExtraction() {
    state.running = true;
    state.paused = false;
    state.stagnation = 0;
    state.loops = 0;
    state.dtParsedTotal = 0;
    state.consecutivePastEnd = 0;
    state.lastInRangeLoop = 0;
    state.lastDateRaw = "";
    state.lastDateIso = "";
    state.lastCandidateCount = 0;

    $startBtn.textContent = "Pause";
    $downloadBtn.disabled = true;

    dbg("run:start", { href: location.href });

    while (state.running && !state.paused) {
      state.loops++;

      const beforeProcessed = state.seenKeys.size;
      const { newlyProcessed } = await processVisiblePosts();
      const afterProcessed = state.seenKeys.size;

      if (shouldStop()) break;

      let grew = false;
      for (let attempt = 1; attempt <= SCROLL_RETRY_MAX; attempt++) {
        const beforeCount = findCandidatePostAnchors().length;
        const ok = await scrollAndWaitForGrowth(beforeCount);
        const afterCount = findCandidatePostAnchors().length;

        dbg("scroll:attempt", { attempt, beforeCount, afterCount, ok });
        if (ok || afterCount > beforeCount) { grew = true; break; }
      }

      if (!grew && afterProcessed === beforeProcessed && newlyProcessed === 0) {
        state.stagnation++;
        dbg("no_growth:stagnation_bump", { stagnation: state.stagnation });
      }

      await sleep(200);
    }

    state.running = false;
    state.paused = false;

    $startBtn.textContent = "Extract again";
    enableDownloadIfAllowed();

    dbg("run:done", {
      results: state.results.length,
      processedUnique: state.seenKeys.size,
      dtParsedTotal: state.dtParsedTotal,
      consecutivePastEnd: state.consecutivePastEnd,
      loops: state.loops
    });

    setStatus(
      `Done.\n` +
      `Results: ${state.results.length}\n` +
      `Processed unique posts: ${state.seenKeys.size}\n` +
      `Dates parsed total: ${state.dtParsedTotal}\n` +
      `Consecutive past-end: ${state.consecutivePastEnd}/${EXTRA_PAST_END_CONSECUTIVE}\n` +
      (KEEP_POSTS_WITH_UNKNOWN_DATE ? `Note: unknown-date posts were included.\n` : "") +
      `Tip: Switch group feed to “Most recent”. Keep the tab active.`
    );
  }

  function pauseExtraction() {
    state.paused = true;
    state.running = false;
    $startBtn.textContent = "Extract again";
    enableDownloadIfAllowed();
    dbg("run:paused");
    setStatus(`Paused.\nResults: ${state.results.length}\nProcessed unique posts: ${state.seenKeys.size}`);
  }

  function resetAndStart() {
    state.results = [];
    state.seenKeys = new Set();
    state.stagnation = 0;

    // keep logs (you can clear manually) — but reset UI status
    $downloadBtn.disabled = true;

    dbg("reset");
    setStatus("Reset complete. Starting...");
    runExtraction();
  }

  /********************
   * EVENTS
   ********************/
  $startBtn.addEventListener("click", () => {
    if (!state.running && $startBtn.textContent === "Start extraction") return runExtraction();
    if (state.running && $startBtn.textContent === "Pause") return pauseExtraction();
    if (!state.running && $startBtn.textContent === "Extract again") return resetAndStart();
  });

  $downloadBtn.addEventListener("click", () => {
    const csv = toCsv(state.results);
    downloadCsv(`posts_${toYMD(new Date())}.csv`, csv);
    dbg("download:csv", { rows: state.results.length });
  });

  $copyLogsBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.logs.join("\n"));
      dbg("logs:copied");
    } catch (e) {
      dbg("logs:copy_failed", { err: String(e) });
      alert("Could not copy logs. Check browser permissions.");
    }
  });

  $clearLogsBtn.addEventListener("click", () => {
    state.logs = [];
    $logbox.textContent = "";
    if ($consoleLogs.checked) console.log("[PostExtractor] logs cleared");
  });

  const observer = new MutationObserver(() => enableDownloadIfAllowed());
  observer.observe($startBtn, { childList: true, subtree: true });

  setStatus("Idle.");
  dbg("init:ready");
})();
