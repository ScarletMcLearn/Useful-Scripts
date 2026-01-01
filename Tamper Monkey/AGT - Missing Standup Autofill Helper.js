// ==UserScript==
// @name         AGT - Standup Missing Sync (Auto-fill + Auto-submit + KeepAlive + Interval Scheduler)
// @namespace    https://allgentech.io/
// @version      2.3.1
// @description  /employee: detects missing daily standup dates, Start/Pause toggle. When running: processes ALL (fills+submits) except excluded. Optional auto-check every N minutes + keep-alive (audio + worker + beacon + scroll nudge + wake lock).
// @match        https://allgentech.io/employee
// @match        https://allgentech.io/employee/
// @match        https://allgentech.io/employee/standup-form*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  // ============================================================
  // ✅ USER CONFIG (ALL DEFAULTS LIVE HERE)
  // ============================================================

  // Storage / timezone
  const STORE_KEY = "agt_standup_sync_v2_3"; // keep same so your saved defaults persist
  const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000; // UTC+6 (fallback if Intl TZ isn't available)

  // Scheduler interval
  const SYNC_CHECK_EVERY_MINUTES = 1; // 1, 5, 10, 15, 30...
  const SYNC_CHECK_INTERVAL_MS = Math.max(60_000, SYNC_CHECK_EVERY_MINUTES * 60_000); // min 1 minute

  // Widget UI defaults
  const WIDGET_RIGHT_PX = 14;
  const WIDGET_BOTTOM_PX = 14;
  const WIDGET_WIDTH_PX = 480;
  const WIDGET_MAX_HEIGHT_VH = 78;

  // Form defaults (what gets filled)
  const DEFAULT_COMMON_WORK =
`Internal and External Meetings;
Meetings with Internal Members (Management + QA);
Resolving queries of Team Members and helping out where necessary;
Create setup functions, utility functions and automated test cases;
Refactor code;
Review Manual Test Cases;
Help Team with Automation;`;

  const DEFAULT_YESTERDAY_TEXT = DEFAULT_COMMON_WORK;
  const DEFAULT_ACHIEVEMENTS_TEXT = "N/A";
  const DEFAULT_TODAY_TEXT = DEFAULT_COMMON_WORK;
  const DEFAULT_TOMORROW_TEXT = DEFAULT_COMMON_WORK;

  const DEFAULT_ASSIGNED_COUNT = 10;
  const DEFAULT_TESTED_COUNT = 10;
  const DEFAULT_BUGS_COUNT = 0;

  const DEFAULT_BLOCKERS = "No";      // "No" => selects No. Anything else => Yes
  const DEFAULT_WORK_STATUS = "Good"; // Good | Moderate | Bad
  const DEFAULT_EXCLUDE_DATES = "";   // leave empty unless you want defaults

  // Default toggles
  const DEFAULT_AUTO_SUBMIT = true;       // fills AND submits
  const DEFAULT_AUTO_DAILY = true;        // periodic check
  const DEFAULT_AUTO_RUN_IF_MISSING = true;

  // Keep Alive config defaults
  const KA_CFG = {
    USE_AUDIO: true,
    USE_WORKER_TICK: true,
    USE_BEACON: true,
    USE_SCROLL_NUDGE: true,
    USE_WAKE_LOCK: true,

    WORKER_TICK_MS: 10_000,
    BEACON_PING_MS: 60_000,
    DRIFT_CHECK_MS: 1500,

    LOG_DEBUG: false,
  };

  // Optional internal timeouts (safe to leave)
  const WAIT_BODY_MAX_TRIES = 200;
  const WAIT_BODY_SLEEP_MS = 25;

  // ============================================================
  // Logging
  // ============================================================
  const LOG = {
    d: (...a) => KA_CFG.LOG_DEBUG && console.log("[agt-standup]", ...a),
    i: (...a) => console.log("[agt-standup]", ...a),
    w: (...a) => console.warn("[agt-standup]", ...a),
    e: (...a) => console.error("[agt-standup]", ...a),
  };

  // -------------------------
  // Utils
  // -------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  async function ensureBody() {
    for (let i = 0; i < WAIT_BODY_MAX_TRIES; i++) {
      if (document.body) return;
      await sleep(WAIT_BODY_SLEEP_MS);
    }
  }

  function safeJsonParse(raw) {
    try { return JSON.parse(raw); } catch { return null; }
  }

  function loadState() {
    return safeJsonParse(localStorage.getItem(STORE_KEY)) || {};
  }

  function saveState(state) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
  }

  function setNativeValue(el, value) {
    if (!el) return;
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function waitFor(fn, timeoutMs = 12000, tickMs = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(tickMs);
    }
    return null;
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function formatDhakaDateTime(msEpoch) {
    try {
      return new Date(msEpoch).toLocaleString("en-GB", {
        timeZone: "Asia/Dhaka",
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return new Date(msEpoch).toISOString();
    }
  }

  // -------------------------
  // Dhaka time helpers
  // -------------------------
  function getDhakaPartsNow() {
    const dt = new Date(Date.now() + DHAKA_OFFSET_MS);
    return {
      y: dt.getUTCFullYear(),
      m: dt.getUTCMonth() + 1,
      d: dt.getUTCDate(),
      hh: dt.getUTCHours(),
      mm: dt.getUTCMinutes(),
      ss: dt.getUTCSeconds(),
    };
  }

  function dhakaISODateNow() {
    const p = getDhakaPartsNow();
    return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  }

  // -------------------------
  // Date parsing / normalization
  // -------------------------
  function normalizeISODate(iso) {
    const m = String(iso || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }

  function normalizeISOLoose(s) {
    const m = String(s || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return `${m[1]}-${pad2(mo)}-${pad2(d)}`;
  }

  function yearFrom2Digits(yy) {
    const n = Number(yy);
    if (!Number.isFinite(n)) return null;
    return n <= 69 ? 2000 + n : 1900 + n;
  }

  function mdyToISO(m, d, y) {
    return normalizeISODate(`${y}-${pad2(m)}-${pad2(d)}`);
  }

  function dmyToISO(d, m, y) {
    return normalizeISODate(`${y}-${pad2(m)}-${pad2(d)}`);
  }

  function uniqSortedISO(dates) {
    const set = new Set(dates.filter(Boolean));
    return Array.from(set).sort();
  }

  function parseISOListFromText(raw) {
    const parts = String(raw || "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const iso = [];
    for (const p of parts) {
      const n = normalizeISODate(p);
      if (n) iso.push(n);
    }
    return uniqSortedISO(iso);
  }

  /**
   * Exclude dates parser:
   * Accepts:
   *  - ISO: YYYY-MM-DD (also YYYY-M-D)
   *  - dd-mm-yy, mm-dd-yy, dd-mm-yyyy, mm-dd-yyyy (also "/")
   * Also extracts ISO embedded in text like "r 2025-12-25."
   */
  function parseExcludeDatesToSet(raw) {
    const set = new Set();
    const parts = String(raw || "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const part of parts) {
      const directIso = normalizeISOLoose(part) || normalizeISODate(part);
      if (directIso) { set.add(directIso); continue; }

      const embedded = part.match(/(\d{4}-\d{1,2}-\d{1,2})/);
      if (embedded) {
        const iso = normalizeISOLoose(embedded[1]) || normalizeISODate(embedded[1]);
        if (iso) { set.add(iso); continue; }
      }

      const m = part.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2}|\d{4})$/);
      if (!m) continue;

      const a = Number(m[1]);
      const b = Number(m[2]);
      const yRaw = m[3];
      const year = yRaw.length === 2 ? yearFrom2Digits(yRaw) : Number(yRaw);
      if (!year) continue;

      let iso = null;
      if (a > 12 && b <= 12) iso = dmyToISO(a, b, year);
      else if (b > 12 && a <= 12) iso = mdyToISO(a, b, year);
      else iso = mdyToISO(a, b, year) || dmyToISO(a, b, year);

      if (iso) set.add(iso);
    }

    return set;
  }

  // -------------------------
  // Defaults payload (now uses top variables)
  // -------------------------
  function getDefaultTexts() {
    return {
      yesterday: DEFAULT_YESTERDAY_TEXT,
      achievements: DEFAULT_ACHIEVEMENTS_TEXT,
      today: DEFAULT_TODAY_TEXT,
      tomorrow: DEFAULT_TOMORROW_TEXT,

      assigned: DEFAULT_ASSIGNED_COUNT,
      tested: DEFAULT_TESTED_COUNT,
      bugs: DEFAULT_BUGS_COUNT,

      blockers: DEFAULT_BLOCKERS,
      workStatus: DEFAULT_WORK_STATUS,
      excludeDates: DEFAULT_EXCLUDE_DATES,

      autoSubmit: DEFAULT_AUTO_SUBMIT,
      autoDaily: DEFAULT_AUTO_DAILY,
      autoRunIfMissing: DEFAULT_AUTO_RUN_IF_MISSING,
    };
  }

  // -------------------------
  // ✅ Robust Missing Dates Extractor (works with async cards)
  // -------------------------
  function extractMissingStandupDatesFromEmployeePage() {
    const TARGET_RE = /Missing\s+Daily\s+Standup/i;
    const CUE_RE = /daily standup for|has not submitted/i;

    const isoDates = [];

    const addIso = (raw) => {
      const iso = normalizeISOLoose(raw) || normalizeISODate(raw);
      if (iso) isoDates.push(iso);
    };

    const addNumericDate = (a, b, y) => {
      const A = Number(a), B = Number(b), Y = Number(y);
      if (!Number.isFinite(A) || !Number.isFinite(B) || !Number.isFinite(Y)) return;

      let iso = null;
      if (A > 12 && B <= 12) iso = dmyToISO(A, B, Y);          // DD/MM/YYYY
      else if (B > 12 && A <= 12) iso = mdyToISO(A, B, Y);     // MM/DD/YYYY
      else iso = mdyToISO(A, B, Y) || dmyToISO(A, B, Y);

      if (iso) isoDates.push(iso);
    };

    const text = (document.body?.innerText || "").replace(/\r/g, "");
    if (!text.trim()) return [];

    const lines = text
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!TARGET_RE.test(line) && !CUE_RE.test(line)) continue;

      const chunk = [
        lines[i - 2], lines[i - 1], lines[i],
        lines[i + 1], lines[i + 2], lines[i + 3],
      ].filter(Boolean).join(" ");

      for (const m of chunk.matchAll(/\b(\d{4}-\d{1,2}-\d{1,2})\b/g)) addIso(m[1]);
      for (const m of chunk.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) addNumericDate(m[1], m[2], m[3]);
      for (const m of chunk.matchAll(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/g)) addNumericDate(m[1], m[2], m[3]);
    }

    return uniqSortedISO(isoDates);
  }

  async function waitForMissingDates(maxWaitMs = 8000) {
    const t0 = Date.now();
    let last = [];
    while (Date.now() - t0 < maxWaitMs) {
      const now = extractMissingStandupDatesFromEmployeePage();
      if (now.length && JSON.stringify(now) === JSON.stringify(last)) return now;
      last = now;
      await sleep(400);
    }
    return extractMissingStandupDatesFromEmployeePage();
  }

  // -------------------------
  // Keep Alive
  // -------------------------
  const KeepAlive = (() => {
    let worker = null;
    let wakeLock = null;
    let audioCtx = null, gain = null, osc = null, audioTag = null;
    let beaconTimer = null;
    let driftTimer = null;
    let running = false;

    const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

    function nudgeScroll() {
      if (!KA_CFG.USE_SCROLL_NUDGE) return;
      try {
        const el = document.scrollingElement || document.documentElement;
        const y = el.scrollTop;
        el.scrollTop = y + 1;
        el.scrollTop = y;
      } catch {}
    }

    async function startAudio() {
      if (!KA_CFG.USE_AUDIO) return;
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        await audioCtx.resume();
        if (!osc) {
          gain = audioCtx.createGain();
          gain.gain.value = 0.001;
          osc = audioCtx.createOscillator();
          osc.frequency.value = 1;
          osc.connect(gain).connect(audioCtx.destination);
          osc.start();
          LOG.d("keepalive audio (webaudio) started");
        }
      } catch {
        try {
          if (!audioTag) {
            audioTag = new Audio(SILENT_WAV);
            audioTag.loop = true;
            audioTag.volume = 0.01;
          }
          await audioTag.play();
          LOG.d("keepalive audio (tag) started");
        } catch {
          LOG.d("keepalive audio blocked (no user gesture?)");
        }
      }
    }

    function stopAudio() {
      try { osc?.stop(); } catch {}
      try { audioCtx?.close(); } catch {}
      try { audioTag?.pause(); } catch {}
      osc = gain = audioCtx = audioTag = null;
    }

    async function acquireWakeLock() {
      if (!KA_CFG.USE_WAKE_LOCK) return;
      if (!("wakeLock" in navigator)) return;
      if (document.hidden) return;

      try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener?.("release", () => LOG.d("wake lock released"));
        LOG.d("wake lock acquired");
      } catch {
        LOG.d("wake lock denied/unavailable");
      }
    }

    function releaseWakeLock() {
      try { wakeLock?.release(); } catch {}
      wakeLock = null;
    }

    function startWorker(onTick) {
      if (!KA_CFG.USE_WORKER_TICK) return;
      stopWorker();
      try {
        const src = `setInterval(()=>postMessage(Date.now()), ${KA_CFG.WORKER_TICK_MS});`;
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
        worker.onmessage = () => {
          try {
            document.body?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
            window.dispatchEvent(new Event("scroll", { bubbles: true }));
            nudgeScroll();
            onTick?.();
          } catch {}
        };
        LOG.d("keepalive worker started");
      } catch {
        LOG.d("keepalive worker failed");
      }
    }

    function stopWorker() {
      try { worker?.terminate(); } catch {}
      worker = null;
    }

    function startBeacon() {
      if (!KA_CFG.USE_BEACON) return;
      stopBeacon();
      beaconTimer = setInterval(() => {
        try { navigator.sendBeacon?.("/favicon.ico", new Blob(["k"])); } catch {}
      }, KA_CFG.BEACON_PING_MS);
      LOG.d("keepalive beacon started");
    }

    function stopBeacon() {
      if (beaconTimer) clearInterval(beaconTimer);
      beaconTimer = null;
    }

    function startDriftCheck(onTick) {
      stopDriftCheck();
      driftTimer = setInterval(() => {
        try { onTick?.(); } catch {}
      }, KA_CFG.DRIFT_CHECK_MS);
    }

    function stopDriftCheck() {
      if (driftTimer) clearInterval(driftTimer);
      driftTimer = null;
    }

    function start(onTick) {
      if (running) return;
      running = true;

      startAudio();
      if (!document.hidden) acquireWakeLock();

      startWorker(onTick);
      startBeacon();
      startDriftCheck(onTick);

      document.addEventListener("visibilitychange", onVis, true);
      LOG.d("keepalive ON");
    }

    function onVis() {
      if (!running) return;
      if (!document.hidden) {
        acquireWakeLock();
        startAudio();
      }
    }

    function stop() {
      if (!running) return;
      running = false;

      document.removeEventListener("visibilitychange", onVis, true);
      stopWorker();
      stopBeacon();
      stopDriftCheck();
      stopAudio();
      releaseWakeLock();
      LOG.d("keepalive OFF");
    }

    function isRunning() { return running; }

    return { start, stop, isRunning };
  })();

  // -------------------------
  // Standup form fill + submit
  // -------------------------
  function buildYesterdayWithAchievements(yesterday, achievements) {
    const y = String(yesterday || "").trim();
    const a = String(achievements || "").trim();
    if (!a) return y;
    return `${y}\n\nAchievements:\n${a}`;
  }

  function resolveAutoDateFromQuery() {
    const url = new URL(location.href);
    return normalizeISODate(url.searchParams.get("autoFillDate"));
  }

  async function fillStandupForm(payload, dateToUse) {
    const form = await waitFor(() => document.querySelector("form"), 15000);
    if (!form) throw new Error("Could not find the standup form <form>.");

    const dateInput = await waitFor(() =>
      form.querySelector('input[placeholder="YYYY-MM-DD"]') ||
      form.querySelector('input.input.input-bordered[type="text"]') ||
      form.querySelector('input[type="text"][name*="date" i]') ||
      form.querySelector('input[type="text"][id*="date" i]'),
      15000
    );
    if (!dateInput) throw new Error("Could not find the Date input.");
    setNativeValue(dateInput, dateToUse);

    const yTa = form.querySelector('textarea[placeholder="What did you do yesterday?"]') || form.querySelector('textarea[name*="yesterday" i]');
    const tTa = form.querySelector('textarea[placeholder="What will you do today?"]') || form.querySelector('textarea[name*="today" i]');
    const tmTa = form.querySelector('textarea[placeholder="What will you do tomorrow?"]') || form.querySelector('textarea[name*="tomorrow" i]');

    if (yTa) setNativeValue(yTa, buildYesterdayWithAchievements(payload.yesterday, payload.achievements));
    if (tTa) setNativeValue(tTa, payload.today || "");
    if (tmTa) setNativeValue(tmTa, payload.tomorrow || "");

    const assigned = form.querySelector('input[placeholder="Number of story/bug tickets assigned"]');
    const tested = form.querySelector('input[placeholder="Number of story tickets tested"]');
    const bugs = form.querySelector('input[placeholder="Number of bug tickets created"]');

    if (assigned) setNativeValue(assigned, String(payload.assigned ?? DEFAULT_ASSIGNED_COUNT));
    if (tested) setNativeValue(tested, String(payload.tested ?? DEFAULT_TESTED_COUNT));
    if (bugs) setNativeValue(bugs, String(payload.bugs ?? DEFAULT_BUGS_COUNT));

    const blockersSelect = $all("select", form).find((s) => {
      const opts = $all("option", s).map((o) => (o.value || o.textContent || "").trim());
      return opts.includes("No") && opts.includes("Yes");
    });
    if (blockersSelect) {
      const b = String(payload.blockers || "").trim().toLowerCase();
      setNativeValue(blockersSelect, b === "no" ? "No" : "Yes");
    }

    // Work status: try radio first, else fallback to select
    const wsWanted = String(payload.workStatus || DEFAULT_WORK_STATUS).trim();
    const radioInputs = $all('input[type="radio"]', form);
    const targetRadio = radioInputs.find((r) => String(r.value || "").trim() === wsWanted);
    if (targetRadio) {
      const label = targetRadio.closest("label");
      (label || targetRadio).click();
      await sleep(80);
    } else {
      const wsSelect = $all("select", form).find((s) => {
        const opts = $all("option", s).map((o) => (o.value || o.textContent || "").trim());
        return opts.includes("Good") && opts.includes("Moderate") && opts.includes("Bad");
      });
      if (wsSelect) setNativeValue(wsSelect, wsWanted);
    }

    return { form };
  }

  async function submitStandupForm(form) {
    const submitBtn =
      form.querySelector('button[type="submit"]') ||
      $all("button", form).find((b) => /submit/i.test(b.textContent || "")) ||
      $all("button", form).find((b) => /submit/i.test(b.getAttribute("aria-label") || ""));

    if (!submitBtn) throw new Error("Could not find Submit button.");
    submitBtn.click();

    await waitFor(() => {
      const btn = form.querySelector('button[type="submit"]');
      if (!btn) return true;
      if (btn.disabled) return true;
      if (location.pathname.replace(/\/+$/, "") !== "/employee/standup-form") return true;
      return false;
    }, 12000, 200);
  }

  // -------------------------
  // Sync runner (queue)
  // -------------------------
  function newRunId() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function getSyncState() {
    const state = loadState();
    state.payload = state.payload || getDefaultTexts();
    state.sync = state.sync || {};
    state.ui = state.ui || {};
    return state;
  }

  function setSyncState(updater) {
    const st = getSyncState();
    const next = updater(st) || st;
    saveState(next);
    return next;
  }

  function computeQueueFromEmployeePage(datesTextOverride = null) {
    const st = getSyncState();
    const payload = st.payload || getDefaultTexts();

    const detected = extractMissingStandupDatesFromEmployeePage();
    const manual = parseISOListFromText(datesTextOverride ?? st.datesText ?? "");
    const merged = uniqSortedISO([...detected, ...manual]);

    const excludeSet = parseExcludeDatesToSet(payload.excludeDates);
    const queue = merged.filter((d) => !excludeSet.has(d));

    return { detected, manual, merged, excludeSet, queue, payload };
  }

  async function startRunFromEmployeePage(setStatus, datesTextOverride = null) {
    const { detected, manual, merged, excludeSet, queue, payload } = computeQueueFromEmployeePage(datesTextOverride);

    if (!queue.length) {
      setStatus(
        `No runnable dates.\nDetected: ${detected.length}\nManual list: ${manual.length}\n` +
        `Excluded removed: ${merged.length - queue.length}\n\nNothing to sync.`
      );
      return;
    }

    const runId = newRunId();

    setSyncState((s) => {
      s.datesText = (datesTextOverride ?? s.datesText ?? merged.join(", "));
      s.payload = payload;

      s.sync = {
        inProgress: true,
        runId,
        queue,
        index: 0,
        startedAt: Date.now(),
        stopRequested: false,
        lastRunSummary: null,
      };
      return s;
    });

    const first = queue[0];
    const url = `https://allgentech.io/employee/standup-form?autoFillDate=${encodeURIComponent(first)}&runId=${encodeURIComponent(runId)}&auto=1`;

    const w = window.open(url, "_blank");
    if (!w) {
      setStatus("Popup blocked. Running in THIS tab instead...");
      location.href = url;
      return;
    }

    setStatus(
      `Started sync.\nTotal dates: ${queue.length}\n` +
      `Auto submit: ${payload.autoSubmit ? "ON" : "OFF"}\n` +
      `Runner tab opened for: ${first}\n` +
      `Exclude list count: ${excludeSet.size}`
    );
  }

  async function runStepOnStandupForm(setStatus) {
    const url = new URL(location.href);
    const runId = url.searchParams.get("runId");
    const isAuto = url.searchParams.get("auto") === "1";
    const dateToUse = resolveAutoDateFromQuery();
    if (!isAuto || !runId || !dateToUse) return;

    KeepAlive.start(() => { /* keep alive only */ });

    const st = getSyncState();
    const payload = st.payload || getDefaultTexts();
    const sync = st.sync || {};

    if (!sync.inProgress || sync.runId !== runId) {
      setStatus("No active sync run found (or runId mismatch). Not doing anything.");
      return;
    }

    if (sync.stopRequested) {
      setStatus("🛑 Stop requested. Ending run and returning to /employee.");
      setSyncState((s) => {
        s.sync.inProgress = false;
        s.sync.lastRunSummary = { stopped: true, at: Date.now() };
        return s;
      });
      await sleep(400);
      location.href = "https://allgentech.io/employee";
      return;
    }

    const excludeSet = parseExcludeDatesToSet(payload.excludeDates);
    if (excludeSet.has(dateToUse)) {
      setStatus(`⏭️ Skipped excluded date: ${dateToUse}`);
    } else {
      setStatus(`Processing: ${dateToUse}\nFill + ${payload.autoSubmit ? "Submit" : "No Submit"}`);
      const { form } = await fillStandupForm(payload, dateToUse);

      if (payload.autoSubmit) {
        await submitStandupForm(form);
        setStatus(`✅ Submitted: ${dateToUse}`);
      } else {
        setStatus(`✅ Filled (not submitted): ${dateToUse}`);
      }
    }

    const next = setSyncState((s) => {
      if (!s.sync || s.sync.runId !== runId) return s;
      s.sync.index = (s.sync.index || 0) + 1;
      return s;
    });

    const q = next.sync.queue || [];
    const idx = next.sync.index || 0;

    if (idx >= q.length) {
      setStatus("✅ All dates processed. Returning to /employee …");
      setSyncState((s) => {
        s.sync.inProgress = false;
        s.sync.completedAt = Date.now();
        s.sync.lastRunSummary = {
          completed: true,
          total: q.length,
          autoSubmit: !!payload.autoSubmit,
          finishedAt: Date.now(),
        };
        return s;
      });
      await sleep(500);
      location.href = "https://allgentech.io/employee";
      return;
    }

    const nextDate = q[idx];
    setStatus(`Continuing… (${idx + 1}/${q.length}) Next: ${nextDate}`);
    await sleep(500);
    location.href = `https://allgentech.io/employee/standup-form?autoFillDate=${encodeURIComponent(nextDate)}&runId=${encodeURIComponent(runId)}&auto=1`;
  }

  // -------------------------
  // Widget (SPA-safe + auto-rescan on async render)
  // -------------------------
  let WIDGET = null;
  let __mo = null;
  let __autoScanTimer = null;
  let __lastAutoScanAt = 0;

  function createOrUpdateWidget(mode) {
    if (WIDGET && WIDGET.root?.isConnected) {
      WIDGET.configure(mode);
      return WIDGET.api;
    }

    const root = document.createElement("div");
    root.id = "agt-standup-sync-widget";
    root.style.cssText = `
      position: fixed;
      right: ${WIDGET_RIGHT_PX}px;
      bottom: ${WIDGET_BOTTOM_PX}px;
      z-index: 999999;
      width: ${WIDGET_WIDTH_PX}px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: #111827;
    `;

    root.innerHTML = `
      <div style="background: rgba(255,255,255,0.97);border: 1px solid rgba(0,0,0,0.12);border-radius: 12px;box-shadow: 0 10px 25px rgba(0,0,0,0.18);overflow: hidden;">
        <div data-head style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(0,0,0,0.08);gap:10px;cursor:pointer;">
          <div style="display:flex;align-items:center;gap:10px;min-width:0;">
            <div style="font-weight:900;font-size:13px;white-space:nowrap;">Standup Sync</div>
            <div data-pill style="font-size:12px;background:rgba(17,24,39,0.06);padding:4px 8px;border-radius:999px;white-space:nowrap;">…</div>
          </div>
          <button data-act="toggle" title="Expand" style="border:none;background:transparent;cursor:pointer;font-size:14px;line-height:1;padding:4px 8px;border-radius:8px;">+</button>
        </div>

        <div data-body style="padding:10px 12px;display:none;max-height:${WIDGET_MAX_HEIGHT_VH}vh;overflow:auto;">
          <div data-employee-only style="display:none;">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
              <button data-act="scan" style="padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#ffffff;cursor:pointer;font-weight:800;font-size:13px;">Scan</button>

              <button data-act="syncToggle" style="flex:1;padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#111827;color:#fff;cursor:pointer;font-weight:900;font-size:13px;">Start Sync</button>

              <button data-act="hardStop" title="Fully stop + clear running state"
                style="padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#fff;color:#b91c1c;cursor:pointer;font-weight:900;font-size:13px;">Stop</button>
            </div>

            <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:8px;">
              <input data-field="autoSubmit" type="checkbox">
              Auto submit (fills AND submits)
            </label>

            <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:8px;">
              <input data-field="autoDaily" type="checkbox">
              Auto check every ${SYNC_CHECK_EVERY_MINUTES} minutes
            </label>

            <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:10px;">
              <input data-field="autoRunIfMissing" type="checkbox">
              If auto-check finds missing → automatically run sync
            </label>

            <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;margin-bottom:10px;">
              Missing dates (ISO only). Editable list (comma/space/newline separated)
              <textarea data-field="dates" rows="2" placeholder="YYYY-MM-DD, YYYY-MM-DD, ..."
                style="resize:vertical;padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;line-height:1.35;"></textarea>
            </label>
          </div>

          <div style="display:grid;grid-template-columns:1fr;gap:10px;">
            <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
              What did you do yesterday?
              <textarea data-field="yesterday" rows="4" style="resize:vertical;padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;line-height:1.35;"></textarea>
            </label>

            <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
              Achievements (appended to Yesterday)
              <input data-field="achievements" type="text" style="padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;">
            </label>

            <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
              What will you do today?
              <textarea data-field="today" rows="4" style="resize:vertical;padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;line-height:1.35;"></textarea>
            </label>

            <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
              What will you do tomorrow?
              <textarea data-field="tomorrow" rows="4" style="resize:vertical;padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;line-height:1.35;"></textarea>
            </label>

            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
              <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
                Story/Bug assigned
                <input data-field="assigned" type="number" min="0" style="padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;">
              </label>
              <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
                Story tested
                <input data-field="tested" type="number" min="0" style="padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;">
              </label>
              <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
                Bugs created
                <input data-field="bugs" type="number" min="0" style="padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;">
              </label>
            </div>

            <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
              Any Blockers / Questions (typing "No" selects No; anything else selects Yes)
              <textarea data-field="blockers" rows="2" style="resize:vertical;padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;line-height:1.35;"></textarea>
            </label>

            <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
              Work Status
              <select data-field="workStatus" style="padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;">
                <option value="Good">Good</option>
                <option value="Moderate">Moderate</option>
                <option value="Bad">Bad</option>
              </select>
            </label>

            <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
              Exclude dates (comma/space separated). Accepts ISO too (e.g. r 2025-12-25.)
              <textarea data-field="excludeDates" rows="2" placeholder="e.g. 25-12-24, 12-31-2024, 2025-12-25"
                style="resize:vertical;padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;line-height:1.35;"></textarea>
            </label>

            <div style="display:flex;gap:8px;align-items:center;">
              <button data-act="save" style="flex:1;padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#ffffff;color:#111827;cursor:pointer;font-weight:900;font-size:13px;">Save Defaults</button>
              <button data-act="fillOnlyHere" style="padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#111827;color:#fff;cursor:pointer;font-weight:900;font-size:13px;">Fill Here (test)</button>
            </div>

            <div data-status style="margin-top:2px;padding:8px 10px;border-radius:10px;background: rgba(17,24,39,0.06);font-size:12px;line-height:1.35;white-space: pre-wrap;min-height:120px;">Ready.</div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const head = root.querySelector("[data-head]");
    const body = root.querySelector("[data-body]");
    const pill = root.querySelector("[data-pill]");
    const statusEl = root.querySelector("[data-status]");
    const employeeOnly = root.querySelector("[data-employee-only]");
    const syncBtn = root.querySelector('button[data-act="syncToggle"]');

    const setStatus = (msg) => (statusEl.textContent = msg);
    const setPill = (msg) => (pill.textContent = msg);

    const f = {
      dates: root.querySelector('[data-field="dates"]'),
      yesterday: root.querySelector('[data-field="yesterday"]'),
      achievements: root.querySelector('[data-field="achievements"]'),
      today: root.querySelector('[data-field="today"]'),
      tomorrow: root.querySelector('[data-field="tomorrow"]'),
      assigned: root.querySelector('[data-field="assigned"]'),
      tested: root.querySelector('[data-field="tested"]'),
      bugs: root.querySelector('[data-field="bugs"]'),
      blockers: root.querySelector('[data-field="blockers"]'),
      workStatus: root.querySelector('[data-field="workStatus"]'),
      excludeDates: root.querySelector('[data-field="excludeDates"]'),
      autoSubmit: root.querySelector('[data-field="autoSubmit"]'),
      autoDaily: root.querySelector('[data-field="autoDaily"]'),
      autoRunIfMissing: root.querySelector('[data-field="autoRunIfMissing"]'),
    };

    function buildPayload() {
      return {
        yesterday: String(f.yesterday.value || ""),
        achievements: String(f.achievements.value || ""),
        today: String(f.today.value || ""),
        tomorrow: String(f.tomorrow.value || ""),

        assigned: Number(f.assigned.value || 0),
        tested: Number(f.tested.value || 0),
        bugs: Number(f.bugs.value || 0),

        blockers: String(f.blockers.value || ""),
        workStatus: String(f.workStatus.value || DEFAULT_WORK_STATUS),
        excludeDates: String(f.excludeDates.value || ""),

        autoSubmit: !!f.autoSubmit.checked,
        autoDaily: !!f.autoDaily.checked,
        autoRunIfMissing: !!f.autoRunIfMissing.checked,
      };
    }

    function applyPayload(p) {
      const def = getDefaultTexts();
      const x = p || def;

      f.yesterday.value = x.yesterday ?? def.yesterday;
      f.achievements.value = x.achievements ?? def.achievements;
      f.today.value = x.today ?? def.today;
      f.tomorrow.value = x.tomorrow ?? def.tomorrow;

      f.assigned.value = String(x.assigned ?? def.assigned);
      f.tested.value = String(x.tested ?? def.tested);
      f.bugs.value = String(x.bugs ?? def.bugs);

      f.blockers.value = x.blockers ?? def.blockers;
      f.workStatus.value = x.workStatus ?? def.workStatus;
      f.excludeDates.value = x.excludeDates ?? def.excludeDates;

      f.autoSubmit.checked = x.autoSubmit ?? def.autoSubmit;
      f.autoDaily.checked = x.autoDaily ?? def.autoDaily;
      f.autoRunIfMissing.checked = x.autoRunIfMissing ?? def.autoRunIfMissing;
    }

    function toggleBody(forceOpen = null) {
      const isOpen = body.style.display !== "none";
      const nextOpen = forceOpen === null ? !isOpen : !!forceOpen;
      body.style.display = nextOpen ? "block" : "none";
      const btn = root.querySelector('button[data-act="toggle"]');
      btn.textContent = nextOpen ? "—" : "+";
      btn.title = nextOpen ? "Minimize" : "Expand";
    }

    head.addEventListener("click", (e) => {
      const isBtn = e.target.closest("button");
      if (!isBtn) toggleBody(null);
    });
    root.querySelector('button[data-act="toggle"]').addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBody(null);
    });

    function refreshSyncButtonLabel() {
      const s = getSyncState();
      const enabled = !!s.syncEnabled;
      const paused = !!s.paused;
      if (!enabled) {
        syncBtn.textContent = "Start Sync";
        syncBtn.style.background = "#111827";
        return;
      }
      if (paused) {
        syncBtn.textContent = "Resume Sync";
        syncBtn.style.background = "#065f46";
      } else {
        syncBtn.textContent = "Pause Sync";
        syncBtn.style.background = "#b91c1c";
      }
    }

    const st = getSyncState();
    applyPayload(st.payload);

    const autosaveFields = [
      "yesterday","achievements","today","tomorrow",
      "assigned","tested","bugs",
      "blockers","workStatus","excludeDates",
      "autoSubmit","autoDaily","autoRunIfMissing"
    ];

    for (const k of autosaveFields) {
      const el = f[k];
      const evt = el.type === "checkbox" ? "change" : "input";
      el.addEventListener(evt, () => {
        const prev = getSyncState();
        prev.payload = buildPayload();
        if (f.dates) prev.datesText = f.dates.value;
        saveState(prev);
      });
    }

    root.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const act = btn.getAttribute("data-act");

      if (act === "save") {
        const prev = getSyncState();
        prev.payload = buildPayload();
        if (f.dates) prev.datesText = f.dates.value;
        saveState(prev);
        setStatus("✅ Saved defaults.");
        return;
      }

      if (act === "scan") {
        const detected = await waitForMissingDates(6000);
        const manual = parseISOListFromText(f.dates.value);
        const merged = uniqSortedISO([...detected, ...manual]);
        f.dates.value = merged.join(", ");
        setPill(`${merged.length} missing`);
        setSyncState((s) => { s.datesText = f.dates.value; return s; });

        const s2 = getSyncState();
        const nextAt = s2.nextCheckAt || 0;
        setStatus(
          `✅ Scan complete\nDetected: ${detected.length}\nTotal list: ${merged.length}\n` +
          `Auto-check interval: ${SYNC_CHECK_EVERY_MINUTES} min\n` +
          `Next scheduled check: ${nextAt ? formatDhakaDateTime(nextAt) + " (BD)" : "Not scheduled yet"}`
        );
        return;
      }

      if (act === "syncToggle") {
        const st0 = getSyncState();
        st0.payload = buildPayload();
        st0.datesText = f.dates.value;
        saveState(st0);

        const enabled = !!st0.syncEnabled;
        const paused = !!st0.paused;

        if (!enabled) {
          setSyncState((s) => {
            s.syncEnabled = true;
            s.paused = false;
            s.nextCheckAt = Date.now() + SYNC_CHECK_INTERVAL_MS;
            return s;
          });
          refreshSyncButtonLabel();

          const payload = getSyncState().payload || getDefaultTexts();
          if (payload.autoDaily) KeepAlive.start(() => maybeIntervalReloadOrRun(setStatus));

          setStatus("▶️ Sync started. Running now…");
          await startRunFromEmployeePage(setStatus, f.dates.value);
          return;
        }

        if (!paused) {
          setSyncState((s) => { s.paused = true; return s; });
          refreshSyncButtonLabel();
          KeepAlive.stop();
          setStatus("⏸️ Sync paused. Auto-checks will NOT run while paused.");
          return;
        }

        setSyncState((s) => {
          s.paused = false;
          const now = Date.now();
          if (!s.nextCheckAt || s.nextCheckAt <= now) s.nextCheckAt = now + SYNC_CHECK_INTERVAL_MS;
          return s;
        });
        refreshSyncButtonLabel();

        const payload = getSyncState().payload || getDefaultTexts();
        if (payload.autoDaily) KeepAlive.start(() => maybeIntervalReloadOrRun(setStatus));

        setStatus("▶️ Sync resumed. Running now…");
        await startRunFromEmployeePage(setStatus, f.dates.value);
        return;
      }

      if (act === "hardStop") {
        setSyncState((s) => {
          s.syncEnabled = false;
          s.paused = false;
          s.nextCheckAt = 0;
          s.lastSchedulerReloadAt = 0;
          s.lastSchedulerAutoRunAt = 0;
          s.sync = s.sync || {};
          s.sync.stopRequested = true;
          s.sync.inProgress = false;
          return s;
        });
        KeepAlive.stop();
        refreshSyncButtonLabel();
        setStatus("🛑 Fully stopped. Runner (if any) will stop on next step.");
        return;
      }

      if (act === "fillOnlyHere") {
        if (location.pathname.replace(/\/+$/, "") !== "/employee/standup-form") {
          setStatus("Fill Here only works on /employee/standup-form.");
          return;
        }
        const stx = getSyncState();
        stx.payload = buildPayload();
        saveState(stx);

        const date = resolveAutoDateFromQuery() || dhakaISODateNow();
        await fillStandupForm(stx.payload, date);
        setStatus(`✅ Filled (test) for ${date}. Not submitted by Fill Here.`);
      }
    });

    if (f.dates) {
      f.dates.addEventListener("input", () => {
        const prev = getSyncState();
        prev.datesText = f.dates.value;
        saveState(prev);
        setPill(`${parseISOListFromText(f.dates.value).length} missing`);
      });
    }

    function configure(mode) {
      const st2 = getSyncState();
      applyPayload(st2.payload);

      if (mode === "employee") {
        employeeOnly.style.display = "block";
        refreshSyncButtonLabel();

        // initial scan (async cards)
        setTimeout(() => { try { root.querySelector('button[data-act="scan"]')?.click(); } catch {} }, 1200);
        setTimeout(() => { try { root.querySelector('button[data-act="scan"]')?.click(); } catch {} }, 3200);

        // MutationObserver auto-rescan (async card rendering)
        const scanBtn = root.querySelector('button[data-act="scan"]');
        const scheduleAutoScan = () => {
          const now = Date.now();
          if (now - __lastAutoScanAt < 1500) return; // throttle
          __lastAutoScanAt = now;
          clearTimeout(__autoScanTimer);
          __autoScanTimer = setTimeout(() => { try { scanBtn?.click(); } catch {} }, 900);
        };

        if (!__mo) {
          try {
            __mo = new MutationObserver(scheduleAutoScan);
            __mo.observe(document.body, { childList: true, subtree: true, characterData: true });
          } catch {}
        }

        const detected = extractMissingStandupDatesFromEmployeePage();
        const existingDates = parseISOListFromText(st2.datesText || "");
        const merged = uniqSortedISO([...detected, ...existingDates]);
        f.dates.value = merged.join(", ");
        setPill(`${merged.length} missing`);

        const nextAt = st2.nextCheckAt || 0;
        setStatus(
          `Detected missing: ${detected.length}\n` +
          `Manual list: ${existingDates.length}\n` +
          `Total list: ${merged.length}\n` +
          `Auto-check interval: ${SYNC_CHECK_EVERY_MINUTES} min\n` +
          `Next scheduled check: ${nextAt ? formatDhakaDateTime(nextAt) + " (BD)" : "Not scheduled yet"}\n` +
          `KeepAlive: ${KeepAlive.isRunning() ? "ON" : "OFF"}`
        );

        setSyncState((s) => { s.datesText = f.dates.value; return s; });
      } else {
        employeeOnly.style.display = "none";
        setPill(mode === "standup-form" ? "runner" : "standup");
        setStatus("Standup form page. Runner will handle auto steps when opened with ?auto=1. Fill Here is test-only.");
      }
    }

    const api = { setStatus, setPill, toggleBody, refreshSyncButtonLabel };
    WIDGET = { root, api, configure };

    configure(mode);
    return api;
  }

  // -------------------------
  // Interval Scheduler
  // -------------------------
  function maybeIntervalReloadOrRun(setStatus) {
    const path = location.pathname.replace(/\/+$/, "");
    if (path !== "/employee") return;

    const st = getSyncState();
    const payload = st.payload || getDefaultTexts();
    if (!st.syncEnabled || st.paused) return;
    if (!payload.autoDaily) return;

    if (st.sync && st.sync.inProgress) return;

    const now = Date.now();

    if (!st.nextCheckAt) {
      setSyncState((s) => { s.nextCheckAt = now + SYNC_CHECK_INTERVAL_MS; return s; });
      return;
    }

    if (st.lastSchedulerReloadAt && (now - st.lastSchedulerReloadAt) < 30_000) return;

    if (now >= st.nextCheckAt) {
      const nextAt = now + SYNC_CHECK_INTERVAL_MS;

      setSyncState((s) => {
        s.lastSchedulerReloadAt = now;
        s.nextCheckAt = nextAt;
        return s;
      });

      setStatus?.(
        `⏱️ Auto-check triggered.\n` +
        `Interval: ${SYNC_CHECK_EVERY_MINUTES} min\n` +
        `Reloading to refresh Pending Tasks…\n` +
        `Next scheduled check: ${formatDhakaDateTime(nextAt)} (BD)`
      );

      location.reload();
    }
  }

  async function afterReloadAutoRunIfMissing(setStatus, toggleBodyFn) {
    const st = getSyncState();
    const payload = st.payload || getDefaultTexts();
    if (!st.syncEnabled || st.paused) return;
    if (!payload.autoDaily) return;

    const now = Date.now();
    const marker = st.lastSchedulerReloadAt || 0;
    if (!marker || (now - marker) > 2 * 60_000) return;

    if (st.lastSchedulerAutoRunAt === marker) return;
    setSyncState((s) => { s.lastSchedulerAutoRunAt = marker; return s; });

    const detected = await waitForMissingDates(9000);

    if (!detected.length) {
      const s2 = getSyncState();
      const nextAt = s2.nextCheckAt || 0;
      setStatus(
        `Auto-check → no missing.\n` +
        `Checked at: ${formatDhakaDateTime(now)} (BD)\n` +
        `Next scheduled check: ${nextAt ? formatDhakaDateTime(nextAt) + " (BD)" : "Not scheduled"}`
      );
      return;
    }

    if (!payload.autoRunIfMissing) {
      setStatus(`Auto-check → missing ${detected.length}, but auto-run is OFF.`);
      return;
    }

    toggleBodyFn?.(true);
    const mergedText = uniqSortedISO([...detected, ...parseISOListFromText(st.datesText || "")]).join(", ");
    setStatus(`Auto-check → missing ${detected.length}\nRunning sync now…`);
    await startRunFromEmployeePage(setStatus, mergedText);
  }

  function setupIntervalSchedulerStatus(setStatus) {
    const path = location.pathname.replace(/\/+$/, "");
    if (path !== "/employee") return;

    const st = getSyncState();
    const payload = st.payload || getDefaultTexts();
    if (!st.syncEnabled || st.paused || !payload.autoDaily) return;

    const now = Date.now();
    const nextAt = st.nextCheckAt || (now + SYNC_CHECK_INTERVAL_MS);
    if (!st.nextCheckAt) setSyncState((s) => { s.nextCheckAt = nextAt; return s; });

    setStatus(
      `Sync running.\n` +
      `Auto-check interval: ${SYNC_CHECK_EVERY_MINUTES} min\n` +
      `Next scheduled check: ${formatDhakaDateTime(nextAt)} (BD)\n` +
      `KeepAlive: ${KeepAlive.isRunning() ? "ON" : "OFF"}`
    );
  }

  // -------------------------
  // SPA route change hook
  // -------------------------
  function hookHistory(onChange) {
    const fire = () => { try { onChange(); } catch (e) { LOG.e("init error", e); } };
    const wrap = (fn) => function(...args) { const r = fn.apply(this, args); setTimeout(fire, 0); return r; };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", fire, true);
  }

  // -------------------------
  // Init
  // -------------------------
  async function initForCurrentPath() {
    await ensureBody();

    const path = location.pathname.replace(/\/+$/, "");

    if (path === "/employee") {
      const api = createOrUpdateWidget("employee");
      const { setStatus, toggleBody } = api;

      const st = getSyncState();
      const payload = st.payload || getDefaultTexts();

      if (st.syncEnabled && !st.paused && payload.autoDaily) {
        KeepAlive.start(() => maybeIntervalReloadOrRun(setStatus));
      } else {
        KeepAlive.stop();
      }

      setupIntervalSchedulerStatus(setStatus);
      await afterReloadAutoRunIfMissing(setStatus, toggleBody);
      return;
    }

    if (path === "/employee/standup-form") {
      const api = createOrUpdateWidget("standup-form");
      const { setStatus } = api;

      try {
        await runStepOnStandupForm(setStatus);
      } catch (err) {
        setStatus(`❌ Runner error:\n${String(err?.message || err)}`);
        setSyncState((s) => {
          s.sync = s.sync || {};
          s.sync.inProgress = false;
          s.sync.lastRunSummary = { error: String(err?.message || err), at: Date.now() };
          return s;
        });
      }
      return;
    }
  }

  hookHistory(initForCurrentPath);
  initForCurrentPath();
})();
