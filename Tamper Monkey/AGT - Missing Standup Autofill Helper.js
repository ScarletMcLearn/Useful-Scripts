// ==UserScript==
// @name         AGT - Standup Missing Sync (Auto-fill + Auto-submit + KeepAlive + Daily BD Midnight)
// @namespace    https://allgentech.io/
// @version      2.1.0
// @description  /employee: detects missing daily standup dates, Start/Pause toggle. When running: processes ALL (fills+submits) except excluded. Optional auto-daily at 12:00 AM Bangladesh time with refresh + keep-alive (audio + worker + beacon + scroll nudge + wake lock).
// @match        https://allgentech.io/employee
// @match        https://allgentech.io/employee/
// @match        https://allgentech.io/employee/standup-form*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const STORE_KEY = "agt_standup_sync_v2_1";
  const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000; // UTC+6 (Bangladesh)

  // -------------------------
  // Keep Alive config (similar to your GitHub script)
  // -------------------------
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
    for (let i = 0; i < 200; i++) {
      if (document.body) return;
      await sleep(25);
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

  function msUntilNextDhakaMidnight() {
    const p = getDhakaPartsNow();
    const targetUtcMs = Date.UTC(p.y, p.m - 1, p.d + 1, 0, 0, 0) - DHAKA_OFFSET_MS;
    return Math.max(0, targetUtcMs - Date.now());
  }

  function formatDhakaNextMidnight() {
    const p = getDhakaPartsNow();
    const tmp = new Date(Date.UTC(p.y, p.m - 1, p.d + 1, 0, 0, 0));
    const y = tmp.getUTCFullYear();
    const m = tmp.getUTCMonth() + 1;
    const d = tmp.getUTCDate();
    return `${y}-${pad2(m)}-${pad2(d)} 00:00 (BD)`;
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
      // direct ISO
      const directIso = normalizeISOLoose(part) || normalizeISODate(part);
      if (directIso) { set.add(directIso); continue; }

      // ISO embedded in junk
      const embedded = part.match(/(\d{4}-\d{1,2}-\d{1,2})/);
      if (embedded) {
        const iso = normalizeISOLoose(embedded[1]) || normalizeISODate(embedded[1]);
        if (iso) { set.add(iso); continue; }
      }

      // dd-mm-yy / mm-dd-yy / dd-mm-yyyy / mm-dd-yyyy
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
  // Defaults payload
  // -------------------------
  function getDefaultTexts() {
    const common =
`Internal and External Meetings;
Meetings with Internal Members (Management + QA);
Resolving queries of Team Members and helping out where necessary;
Create setup functions, utility functions and automated test cases;
Refactor code;
Review Manual Test Cases;
Help Team with Automation;`;

    return {
      yesterday: common,
      achievements: "N/A",
      today: common,
      tomorrow: common,
      assigned: 10,
      tested: 10,
      bugs: 0,
      blockers: "No",
      workStatus: "Good",
      excludeDates: "",

      autoSubmit: true,        // you asked for submit in sync mode
      autoDaily: true,         // you asked for daily midnight checks
      autoRunIfMissing: true,  // when daily check finds missing → run
    };
  }

  // -------------------------
  // Extract missing dates from /employee Pending Tasks DOM
  // -------------------------
  function extractMissingStandupDatesFromEmployeePage() {
    const lis = $all("li");
    const isoDates = [];

    for (const li of lis) {
      const txt = (li.textContent || "").replace(/\s+/g, " ").trim();
      if (!txt) continue;
      if (!/Missing Daily Standup/i.test(txt)) continue;

      const mIso = txt.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (mIso) {
        const iso = normalizeISODate(mIso[1]);
        if (iso) isoDates.push(iso);
        continue;
      }

      const mMdy = txt.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
      if (mMdy) {
        const iso = mdyToISO(mMdy[1], mMdy[2], mMdy[3]);
        if (iso) isoDates.push(iso);
      }
    }

    return uniqSortedISO(isoDates);
  }

  // -------------------------
  // Keep Alive (audio + worker + beacon + scroll + wake lock + drift checks)
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
          // Most browsers require a user gesture; we'll just fail silently.
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

      // Best effort: audio + wake lock work best after user click
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
      form.querySelector('input.input.input-bordered[type="text"]'),
      15000
    );
    if (!dateInput) throw new Error("Could not find the Date input.");
    setNativeValue(dateInput, dateToUse);

    const yTa = form.querySelector('textarea[placeholder="What did you do yesterday?"]');
    const tTa = form.querySelector('textarea[placeholder="What will you do today?"]');
    const tmTa = form.querySelector('textarea[placeholder="What will you do tomorrow?"]');

    if (yTa) setNativeValue(yTa, buildYesterdayWithAchievements(payload.yesterday, payload.achievements));
    if (tTa) setNativeValue(tTa, payload.today || "");
    if (tmTa) setNativeValue(tmTa, payload.tomorrow || "");

    const assigned = form.querySelector('input[placeholder="Number of story/bug tickets assigned"]');
    const tested = form.querySelector('input[placeholder="Number of story tickets tested"]');
    const bugs = form.querySelector('input[placeholder="Number of bug tickets created"]');

    if (assigned) setNativeValue(assigned, String(payload.assigned ?? 10));
    if (tested) setNativeValue(tested, String(payload.tested ?? 10));
    if (bugs) setNativeValue(bugs, String(payload.bugs ?? 0));

    const blockersSelect = $all("select", form).find((s) => {
      const opts = $all("option", s).map((o) => (o.value || o.textContent || "").trim());
      return opts.includes("No") && opts.includes("Yes");
    });
    if (blockersSelect) {
      const b = String(payload.blockers || "").trim().toLowerCase();
      setNativeValue(blockersSelect, b === "no" ? "No" : "Yes");
    }

    const wsWanted = String(payload.workStatus || "Good").trim();
    const radioInputs = $all('input[type="radio"][name="Work Status"]', form);
    const targetRadio = radioInputs.find((r) => String(r.value || "").trim() === wsWanted);
    if (targetRadio) {
      const label = targetRadio.closest("label");
      (label || targetRadio).click();
      await sleep(80);
    }

    return { form };
  }

  async function submitStandupForm(form) {
    const submitBtn = form.querySelector('button[type="submit"]');
    if (!submitBtn) throw new Error("Could not find Submit button.");
    submitBtn.click();

    // Best-effort: wait for navigation or button disable/state change
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

    // Try new tab (preferred). If blocked, run in same tab.
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

    // KeepAlive in runner tab too (best-effort)
    KeepAlive.start(() => { /* just keeping alive */ });

    const st = getSyncState();
    const payload = st.payload || getDefaultTexts();
    const sync = st.sync || {};

    if (!sync.inProgress || sync.runId !== runId) {
      setStatus("No active sync run found (or runId mismatch). Not doing anything.");
      return;
    }

    // Stop request?
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

    // Respect exclusions (in case changed mid-run)
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

    // Advance
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
  // Widget
  // -------------------------
  function createWidget(mode) {
    if (document.getElementById("agt-standup-sync-widget")) return;

    const root = document.createElement("div");
    root.id = "agt-standup-sync-widget";
    root.style.cssText = `
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 999999;
      width: 480px;
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

        <div data-body style="padding:10px 12px;display:none;max-height:78vh;overflow:auto;">
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
              Auto daily check @ 12:00 AM Bangladesh time (best-effort; requires browser open)
            </label>

            <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:10px;">
              <input data-field="autoRunIfMissing" type="checkbox">
              If auto-daily finds missing → automatically run sync
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
        workStatus: String(f.workStatus.value || "Good"),
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

    // init
    const st = getSyncState();
    applyPayload(st.payload);

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

    // Employee-only mode init
    if (mode === "employee") {
      employeeOnly.style.display = "block";
      const detected = extractMissingStandupDatesFromEmployeePage();
      const existingDates = parseISOListFromText(st.datesText || "");
      const merged = uniqSortedISO([...detected, ...existingDates]);
      f.dates.value = merged.join(", ");
      setPill(`${merged.length} missing`);
      refreshSyncButtonLabel();

      setStatus(
        `Detected missing: ${detected.length}\n` +
        `Manual list: ${existingDates.length}\n` +
        `Total list: ${merged.length}\n` +
        `Next midnight check: ${formatDhakaNextMidnight()}\n` +
        `KeepAlive: ${KeepAlive.isRunning() ? "ON" : "OFF"}`
      );

      setSyncState((s) => { s.datesText = f.dates.value; return s; });
    } else {
      setPill(mode === "standup-form" ? "runner" : "standup");
      setStatus("Standup form page. Runner will handle auto steps when opened with ?auto=1. Fill Here is test-only.");
    }

    // autosave
    const autosaveFields = ["yesterday","achievements","today","tomorrow","assigned","tested","bugs","blockers","workStatus","excludeDates","autoSubmit","autoDaily","autoRunIfMissing"];
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

    // actions
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
        const detected = extractMissingStandupDatesFromEmployeePage();
        const manual = parseISOListFromText(f.dates.value);
        const merged = uniqSortedISO([...detected, ...manual]);
        f.dates.value = merged.join(", ");
        setPill(`${merged.length} missing`);
        setSyncState((s) => { s.datesText = f.dates.value; return s; });
        setStatus(`✅ Scan complete\nDetected: ${detected.length}\nTotal list: ${merged.length}\nNext midnight: ${formatDhakaNextMidnight()}`);
        return;
      }

      if (act === "syncToggle") {
        // user gesture: best time to start audio + wake lock
        const st0 = getSyncState();
        st0.payload = buildPayload();
        st0.datesText = f.dates.value;
        saveState(st0);

        const enabled = !!st0.syncEnabled;
        const paused = !!st0.paused;

        if (!enabled) {
          // START
          setSyncState((s) => { s.syncEnabled = true; s.paused = false; return s; });
          refreshSyncButtonLabel();

          // KeepAlive ON if autoDaily ON (or while running)
          const payload = getSyncState().payload || getDefaultTexts();
          if (payload.autoDaily) KeepAlive.start(() => maybeDailyReloadOrRun(setStatus));

          setStatus("▶️ Sync started. Running now…");
          await startRunFromEmployeePage(setStatus, f.dates.value);
          return;
        }

        if (!paused) {
          // PAUSE
          setSyncState((s) => { s.paused = true; return s; });
          refreshSyncButtonLabel();
          KeepAlive.stop();
          setStatus("⏸️ Sync paused. Daily checks will NOT run while paused.");
          return;
        }

        // RESUME
        setSyncState((s) => { s.paused = false; return s; });
        refreshSyncButtonLabel();

        const payload = getSyncState().payload || getDefaultTexts();
        if (payload.autoDaily) KeepAlive.start(() => maybeDailyReloadOrRun(setStatus));

        setStatus("▶️ Sync resumed. Running now…");
        await startRunFromEmployeePage(setStatus, f.dates.value);
        return;
      }

      if (act === "hardStop") {
        setSyncState((s) => {
          s.syncEnabled = false;
          s.paused = false;
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
        const st = getSyncState();
        st.payload = buildPayload();
        saveState(st);

        const date = resolveAutoDateFromQuery() || dhakaISODateNow();
        await fillStandupForm(st.payload, date);
        setStatus(`✅ Filled (test) for ${date}. Not submitted by Fill Here.`);
      }
    });

    // keep pill updated when editing dates
    if (f.dates) {
      f.dates.addEventListener("input", () => {
        const prev = getSyncState();
        prev.datesText = f.dates.value;
        saveState(prev);
        setPill(`${parseISOListFromText(f.dates.value).length} missing`);
      });
    }

    return { setStatus, setPill, toggleBody, refreshSyncButtonLabel };
  }

  // -------------------------
  // Daily scheduler + drift-safe reload
  // -------------------------
  function maybeDailyReloadOrRun(setStatus) {
    const path = location.pathname.replace(/\/+$/, "");
    if (path !== "/employee") return;

    const st = getSyncState();
    const payload = st.payload || getDefaultTexts();
    if (!st.syncEnabled || st.paused) return;
    if (!payload.autoDaily) return;

    // If we've crossed into a new Dhaka date and haven't checked yet, do a reload.
    const todayDhaka = dhakaISODateNow();
    const last = st.lastDailyDhaka || null;
    if (last !== todayDhaka) {
      setSyncState((s) => { s.lastDailyDhaka = todayDhaka; return s; });
      // reload to make sure Pending Tasks is fresh
      location.reload();
    }
  }

  function setupMidnightRefresh(setStatus) {
    const path = location.pathname.replace(/\/+$/, "");
    if (path !== "/employee") return;

    const st = getSyncState();
    const payload = st.payload || getDefaultTexts();
    if (!st.syncEnabled || st.paused) return;
    if (!payload.autoDaily) return;

    const ms = msUntilNextDhakaMidnight();
    setStatus(
      `Sync running.\nNext midnight refresh: ${formatDhakaNextMidnight()}\nKeepAlive: ${KeepAlive.isRunning() ? "ON" : "OFF"}`
    );

    // schedule an exact reload (best effort)
    setTimeout(() => {
      const st2 = getSyncState();
      const payload2 = st2.payload || getDefaultTexts();
      if (!st2.syncEnabled || st2.paused || !payload2.autoDaily) return;
      if (location.pathname.replace(/\/+$/, "") === "/employee") location.reload();
    }, ms + 250);
  }

  async function afterReloadAutoRunIfMissing(setStatus, toggleBodyFn) {
    const st = getSyncState();
    const payload = st.payload || getDefaultTexts();
    if (!st.syncEnabled || st.paused) return;
    if (!payload.autoDaily) return;

    // once per Dhaka day
    const todayDhaka = dhakaISODateNow();
    if (st.lastAutoRunDhaka === todayDhaka) return;
    setSyncState((s) => { s.lastAutoRunDhaka = todayDhaka; return s; });

    const detected = extractMissingStandupDatesFromEmployeePage();
    if (!detected.length) {
      setStatus(`Daily check (${todayDhaka}) → no missing.\nNext: ${formatDhakaNextMidnight()}`);
      return;
    }

    if (!payload.autoRunIfMissing) {
      setStatus(`Daily check (${todayDhaka}) → missing ${detected.length}, but auto-run is OFF.`);
      return;
    }

    // Auto-run
    toggleBodyFn?.(true);
    const mergedText = uniqSortedISO([...detected, ...parseISOListFromText(st.datesText || "")]).join(", ");
    setStatus(`Daily check (${todayDhaka}) → missing ${detected.length}\nRunning sync now…`);
    await startRunFromEmployeePage(setStatus, mergedText);
  }

  // -------------------------
  // SPA route change hook (so widget doesn't "disappear")
  // -------------------------
  function hookHistory(onChange) {
    const fire = () => { try { onChange(); } catch {} };
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
      const { setStatus, toggleBody } = createWidget("employee");

      // if syncEnabled & not paused & autoDaily -> keepalive ON
      const st = getSyncState();
      const payload = st.payload || getDefaultTexts();
      if (st.syncEnabled && !st.paused && payload.autoDaily) {
        // KeepAlive tick also handles drift-safe "new day" detection
        KeepAlive.start(() => maybeDailyReloadOrRun(setStatus));
      } else {
        KeepAlive.stop();
      }

      setupMidnightRefresh(setStatus);
      await afterReloadAutoRunIfMissing(setStatus, toggleBody);
      return;
    }

    if (path === "/employee/standup-form") {
      const { setStatus } = createWidget("standup-form");
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

    // outside intended pages: do nothing
  }

  hookHistory(initForCurrentPath);

  // run once
  initForCurrentPath();
})();
