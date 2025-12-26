// ==UserScript==
// @name         AGT - Standup Missing Sync (Toggle Start/Pause/Resume + Auto-submit + Daily BD Midnight)
// @namespace    https://allgentech.io/
// @version      2.1.0
// @description  /employee: detects missing daily standup dates. Single toggle button: Start -> Pause -> Resume (SHIFT+Click = Stop). When running, auto-checks daily at 12:00 AM Bangladesh time (tab must be open; otherwise runs next time you open /employee). /standup-form runner fills+submits for each missing date except excluded.
// @match        https://allgentech.io/employee*
// @match        https://allgentech.io/employee/standup-form*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const STORE_KEY = "agt_standup_sync_v2_1";
  const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000; // UTC+6 (Bangladesh)
  const RUNNER_FLAG_KEY = "agt_standup_runner_tab";

  // -------------------------
  // Utils
  // -------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  async function ensureBody() {
    if (document.body) return;
    for (let i = 0; i < 120; i++) {
      if (document.body) return;
      await sleep(50);
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

  function mdyToISO(m, d, y) {
    return normalizeISODate(`${y}-${pad2(m)}-${pad2(d)}`);
  }
  function dmyToISO(d, m, y) {
    return normalizeISODate(`${y}-${pad2(m)}-${pad2(d)}`);
  }

  function yearFrom2Digits(yy) {
    const n = Number(yy);
    if (!Number.isFinite(n)) return null;
    return n <= 69 ? 2000 + n : 1900 + n;
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

  // Exclude parser supports:
  // - ISO (YYYY-MM-DD) even embedded in junk: "r 2025-12-25."
  // - dd-mm-yy, mm-dd-yy, dd-mm-yyyy, mm-dd-yyyy (also "/")
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
      else iso = mdyToISO(a, b, year) || dmyToISO(a, b, year); // ambiguous -> MM-DD first

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
      autoSubmit: true,   // you asked for submit now
      autoDaily: true,    // you asked for daily checks
      autoRunIfMissing: true
    };
  }

  // -------------------------
  // Missing date extraction
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
  // Standup form filling + submit
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

  async function fillStandupForm(payload, dateToUse, setStatus) {
    setStatus(`Filling form for: ${dateToUse}`);

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

    setStatus(`Filled fields for ${dateToUse}.`);
    return { form };
  }

  async function submitStandupForm(form, setStatus) {
    const submitBtn = form.querySelector('button[type="submit"]');
    if (!submitBtn) throw new Error("Could not find Submit button.");

    setStatus("Submitting...");
    submitBtn.click();

    await sleep(800); // give it a moment
    setStatus("Submit clicked. (Continuing…)");

    // If app navigates away after submit, that’s fine.
  }

  // -------------------------
  // Sync state helpers
  // -------------------------
  function newRunId() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function getState() {
    const s = loadState();
    s.payload = s.payload || getDefaultTexts();
    s.sync = s.sync || {};
    if (!s.sync.mode) s.sync.mode = "stopped"; // stopped | running | paused
    return s;
  }

  function setState(mutator) {
    const s = getState();
    const next = mutator(s) || s;
    saveState(next);
    return next;
  }

  function isStopRequested() {
    return !!getState().sync?.stopRequested;
  }

  function isPauseRequested() {
    return !!getState().sync?.pauseRequested;
  }

  // -------------------------
  // Run queue start
  // -------------------------
  async function startRunFromEmployeePage(setStatus, datesTextOverride = null) {
    const st = getState();
    const payload = st.payload || getDefaultTexts();

    const detected = extractMissingStandupDatesFromEmployeePage();
    const manual = parseISOListFromText(datesTextOverride ?? st.datesText ?? "");
    const merged = uniqSortedISO([...detected, ...manual]);

    const excludeSet = parseExcludeDatesToSet(payload.excludeDates);
    const queue = merged.filter((d) => !excludeSet.has(d));

    if (!queue.length) {
      setStatus(
        `No runnable dates.\nDetected: ${detected.length}\nManual list: ${manual.length}\n` +
        `Excluded removed: ${merged.length - queue.length}\n\nNothing to sync.`
      );
      // keep mode running if user started it; daily may find later
      return;
    }

    const runId = newRunId();

    setState((s) => {
      s.datesText = (datesTextOverride ?? s.datesText ?? merged.join(", "));
      s.payload = payload;
      s.sync = {
        ...s.sync,
        inProgress: true,
        runId,
        queue,
        index: 0,
        startedAt: Date.now(),
        stopRequested: false,
        pauseRequested: false, // start fresh
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
      `✅ Sync started.\nTotal dates: ${queue.length}\n` +
      `Auto submit: ${payload.autoSubmit ? "ON" : "OFF"}\n` +
      `Runner opened for: ${first}`
    );
  }

  // -------------------------
  // Runner step on standup-form
  // -------------------------
  async function runStepOnStandupForm(setStatus) {
    const url = new URL(location.href);
    const runId = url.searchParams.get("runId");
    const isAuto = url.searchParams.get("auto") === "1";
    const dateToUse = resolveAutoDateFromQuery();
    if (!isAuto || !runId || !dateToUse) return;

    sessionStorage.setItem(RUNNER_FLAG_KEY, "1");

    const st = getState();
    const payload = st.payload || getDefaultTexts();
    const sync = st.sync || {};

    if (!sync.inProgress || sync.runId !== runId) {
      setStatus("No active sync run found (or runId mismatch). Not doing anything.");
      return;
    }

    if (sync.stopRequested) {
      setStatus("🛑 Stop requested. Ending run & returning to /employee …");
      setState((s) => {
        s.sync.inProgress = false;
        s.sync.mode = "stopped";
        return s;
      });
      await sleep(400);
      location.href = "https://allgentech.io/employee";
      return;
    }

    // Exclude check (live)
    const excludeSet = parseExcludeDatesToSet(payload.excludeDates);
    if (excludeSet.has(dateToUse)) {
      setStatus(`⏭️ Skipped excluded date: ${dateToUse}`);
    } else {
      const { form } = await fillStandupForm(payload, dateToUse, setStatus);
      if (payload.autoSubmit) {
        await submitStandupForm(form, setStatus);
      } else {
        setStatus(`Filled ${dateToUse}. Auto submit is OFF (not submitting).`);
      }
    }

    // If pause requested, STOP HERE and wait until resumed/stopped
    if (isPauseRequested()) {
      setStatus(
        `⏸️ Paused after processing: ${dateToUse}\n\n` +
        `Go to /employee and press Resume.\n` +
        `SHIFT+Click toggle to Stop.`
      );

      while (true) {
        await sleep(500);
        const cur = getState();
        if (cur.sync?.stopRequested) {
          setStatus("🛑 Stop requested while paused. Returning to /employee …");
          setState((s) => {
            s.sync.inProgress = false;
            s.sync.mode = "stopped";
            return s;
          });
          await sleep(300);
          location.href = "https://allgentech.io/employee";
          return;
        }
        if (!cur.sync?.pauseRequested && cur.sync?.mode === "running") {
          break; // resume
        }
      }
      setStatus("▶️ Resumed. Continuing…");
    }

    // Advance queue
    const next = setState((s) => {
      if (!s.sync || s.sync.runId !== runId) return s;
      s.sync.index = (s.sync.index || 0) + 1;
      return s;
    });

    const q = next.sync.queue || [];
    const idx = next.sync.index || 0;

    if (idx >= q.length) {
      setStatus("✅ All dates processed. Returning to /employee …");

      setState((s) => {
        s.sync.inProgress = false;
        // IMPORTANT: keep mode as-is (running continues daily checks unless user stops)
        s.sync.completedAt = Date.now();
        return s;
      });

      await sleep(600);
      location.href = "https://allgentech.io/employee";
      return;
    }

    const nextDate = q[idx];
    setStatus(`Continuing… (${idx + 1}/${q.length}) Next: ${nextDate}`);
    await sleep(600);
    location.href =
      `https://allgentech.io/employee/standup-form?autoFillDate=${encodeURIComponent(nextDate)}&runId=${encodeURIComponent(runId)}&auto=1`;
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
              <button data-act="syncToggle" style="flex:1;padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#111827;color:#fff;cursor:pointer;font-weight:900;font-size:13px;">
                Start Sync
              </button>
            </div>

            <div style="font-size:12px;color:rgba(17,24,39,0.75);margin:-4px 0 10px 0;">
              Toggle behavior: <b>Start → Pause → Resume</b>. <b>SHIFT+Click</b> the same button to <b>Stop/Reset</b>.
            </div>

            <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:8px;">
              <input data-field="autoSubmit" type="checkbox">
              Auto submit (fills AND submits)
            </label>

            <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:8px;">
              <input data-field="autoDaily" type="checkbox">
              Daily check @ 12:00 AM Bangladesh time (tab must remain open; otherwise runs next time you open /employee)
            </label>

            <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:10px;">
              <input data-field="autoRunIfMissing" type="checkbox">
              If daily check finds missing dates → auto-run sync
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
              Exclude dates (comma/space separated). Supports ISO too (e.g. 2025-12-25). Also accepts dd-mm-yy/mm-dd-yyyy etc.
              <textarea data-field="excludeDates" rows="2" placeholder="e.g. 2025-12-25, 25-12-24, 12-31-2024"
                style="resize:vertical;padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;line-height:1.35;"></textarea>
            </label>

            <div style="display:flex;gap:8px;align-items:center;">
              <button data-act="save" style="flex:1;padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#ffffff;color:#111827;cursor:pointer;font-weight:900;font-size:13px;">Save Defaults</button>
              <button data-act="fillOnlyHere" style="padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#111827;color:#fff;cursor:pointer;font-weight:900;font-size:13px;">Fill Here (test)</button>
            </div>

            <div data-status style="margin-top:2px;padding:8px 10px;border-radius:10px;background: rgba(17,24,39,0.06);font-size:12px;line-height:1.35;white-space: pre-wrap;min-height:110px;">Ready.</div>
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
    const toggleBtn = root.querySelector('button[data-act="syncToggle"]');

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

      f.autoSubmit.checked = x.autoSubmit ?? true;
      f.autoDaily.checked = x.autoDaily ?? true;
      f.autoRunIfMissing.checked = x.autoRunIfMissing ?? true;
    }

    function toggleBody(forceOpen = null) {
      const isOpen = body.style.display !== "none";
      const nextOpen = forceOpen === null ? !isOpen : !!forceOpen;
      body.style.display = nextOpen ? "block" : "none";
      const btn = root.querySelector('button[data-act="toggle"]');
      btn.textContent = nextOpen ? "—" : "+";
      btn.title = nextOpen ? "Minimize" : "Expand";
    }

    function syncButtonUiFromState() {
      const st = getState();
      const mode = st.sync?.mode || "stopped"; // stopped|running|paused
      const inProg = !!st.sync?.inProgress;

      if (!toggleBtn) return;

      if (mode === "running") {
        toggleBtn.textContent = "Pause";
        toggleBtn.style.background = "#111827";
        toggleBtn.style.color = "#fff";
      } else if (mode === "paused") {
        toggleBtn.textContent = "Resume";
        toggleBtn.style.background = "#2563eb";
        toggleBtn.style.color = "#fff";
      } else {
        toggleBtn.textContent = "Start Sync";
        toggleBtn.style.background = "#111827";
        toggleBtn.style.color = "#fff";
      }

      // pill
      if (mode === "running") setPill(inProg ? "running…" : "running");
      if (mode === "paused") setPill("paused");
      if (mode === "stopped") setPill("stopped");
    }

    // init state
    const st = getState();
    applyPayload(st.payload);

    // expand/collapse
    head.addEventListener("click", (e) => {
      const isBtn = e.target.closest("button");
      if (!isBtn) toggleBody(null);
    });
    root.querySelector('button[data-act="toggle"]').addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBody(null);
    });

    // employee only setup
    if (mode === "employee") {
      employeeOnly.style.display = "block";
      const detected = extractMissingStandupDatesFromEmployeePage();
      const existingDates = parseISOListFromText(st.datesText || "");
      const merged = uniqSortedISO([...detected, ...existingDates]);
      f.dates.value = merged.join(", ");
      setState((s) => { s.datesText = f.dates.value; return s; });

      setStatus(
        `Detected: ${detected.length}\nManual list: ${existingDates.length}\nTotal: ${merged.length}\n\n` +
        `Next daily check time: ${formatDhakaNextMidnight()}`
      );
      setPill(`${merged.length} missing`);
    } else {
      setPill(mode === "standup-form" ? "runner" : "standup");
      setStatus("Standup form page. Runner will auto-step if opened with auto=1.");
    }

    syncButtonUiFromState();

    // autosave payload
    const autosaveFields = ["yesterday","achievements","today","tomorrow","assigned","tested","bugs","blockers","workStatus","excludeDates","autoSubmit","autoDaily","autoRunIfMissing"];
    for (const k of autosaveFields) {
      const el = f[k];
      const evt = el.type === "checkbox" ? "change" : "input";
      el.addEventListener(evt, () => {
        setState((s) => {
          s.payload = buildPayload();
          if (f.dates) s.datesText = f.dates.value;
          return s;
        });
      });
    }

    // action clicks
    root.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const act = btn.getAttribute("data-act");

      if (act === "save") {
        setState((s) => {
          s.payload = buildPayload();
          if (f.dates) s.datesText = f.dates.value;
          return s;
        });
        setStatus("✅ Saved defaults.");
        return;
      }

      if (act === "scan") {
        const detected = extractMissingStandupDatesFromEmployeePage();
        const manual = parseISOListFromText(f.dates.value);
        const merged = uniqSortedISO([...detected, ...manual]);
        f.dates.value = merged.join(", ");
        setPill(`${merged.length} missing`);

        setState((s) => { s.datesText = f.dates.value; return s; });

        setStatus(
          `✅ Scan complete\nDetected: ${detected.length}\nMerged total: ${merged.length}\n\n` +
          `Next daily check time: ${formatDhakaNextMidnight()}`
        );
        return;
      }

      // MAIN TOGGLE
      if (act === "syncToggle") {
        if (location.pathname.replace(/\/+$/, "") !== "/employee") {
          setStatus("This toggle only controls sync from /employee.");
          return;
        }

        const shiftStop = !!e.shiftKey;
        const stNow = getState();

        // persist current payload + dates before actions
        setState((s) => {
          s.payload = buildPayload();
          s.datesText = f.dates.value;
          return s;
        });

        if (shiftStop) {
          // STOP/RESET
          setState((s) => {
            s.sync = s.sync || {};
            s.sync.stopRequested = true;
            s.sync.pauseRequested = false;
            s.sync.mode = "stopped";
            return s;
          });

          setStatus("🛑 Stop requested (SHIFT+Click). Runner will stop safely after current step.");
          syncButtonUiFromState();
          return;
        }

        const modeNow = stNow.sync?.mode || "stopped";

        if (modeNow === "stopped") {
          // START
          setState((s) => {
            s.sync = s.sync || {};
            s.sync.mode = "running";
            s.sync.stopRequested = false;
            s.sync.pauseRequested = false;
            return s;
          });
          syncButtonUiFromState();

          await startRunFromEmployeePage(setStatus, f.dates.value);
          return;
        }

        if (modeNow === "running") {
          // PAUSE
          setState((s) => {
            s.sync = s.sync || {};
            s.sync.mode = "paused";
            s.sync.pauseRequested = true;
            return s;
          });
          setStatus("⏸️ Pause requested. Runner will pause after current date is processed.");
          syncButtonUiFromState();
          return;
        }

        if (modeNow === "paused") {
          // RESUME
          const s2 = setState((s) => {
            s.sync = s.sync || {};
            s.sync.mode = "running";
            s.sync.pauseRequested = false;
            return s;
          });

          syncButtonUiFromState();

          // If runner tab is gone / not in progress, just start a new run.
          if (!s2.sync?.inProgress) {
            setStatus("▶️ Resumed, but no active runner found. Starting a fresh run…");
            await startRunFromEmployeePage(setStatus, f.dates.value);
          } else {
            setStatus("▶️ Resumed. Runner will continue in its tab.");
          }
          return;
        }
      }

      if (act === "fillOnlyHere") {
        if (location.pathname.replace(/\/+$/, "") !== "/employee/standup-form") {
          setStatus("Fill Here only works on /employee/standup-form.");
          return;
        }
        setState((s) => { s.payload = buildPayload(); return s; });

        const st = getState();
        const date = resolveAutoDateFromQuery() || dhakaISODateNow();
        await fillStandupForm(st.payload, date, setStatus);
        setStatus(`✅ Filled (test) for ${date}. Not submitted by Fill Here.`);
      }
    });

    // keep button fresh
    const int = setInterval(() => {
      if (!document.body.contains(root)) { clearInterval(int); return; }
      syncButtonUiFromState();
    }, 800);

    // storage event (other tab updates)
    window.addEventListener("storage", (ev) => {
      if (ev.key === STORE_KEY) syncButtonUiFromState();
    });

    return { setStatus, setPill, toggleBody };
  }

  // -------------------------
  // Daily scheduler (only when running & not paused)
  // -------------------------
  async function setupDailyCheckOnEmployeePage(setStatus) {
    const st = getState();
    const payload = st.payload || getDefaultTexts();

    // Only when user left mode as running
    if (st.sync?.mode !== "running") {
      setStatus(
        `Mode: ${st.sync?.mode || "stopped"}\n` +
        `Daily checks run only when Mode is RUNNING.\n` +
        `Next midnight: ${formatDhakaNextMidnight()}`
      );
      return;
    }

    if (!payload.autoDaily) {
      setStatus(
        `Mode: RUNNING\nDaily check is OFF (toggle it ON).\nNext midnight: ${formatDhakaNextMidnight()}`
      );
      return;
    }

    // Do once per Dhaka day
    const todayDhaka = dhakaISODateNow();
    const last = st.lastDailyDhaka || null;

    if (last !== todayDhaka) {
      setState((s) => { s.lastDailyDhaka = todayDhaka; return s; });

      // refresh missing list from DOM
      const detected = extractMissingStandupDatesFromEmployeePage();

      setStatus(
        `Daily check (${todayDhaka})\nMissing detected: ${detected.length}\n` +
        `Auto-run if missing: ${payload.autoRunIfMissing ? "ON" : "OFF"}\n\n` +
        `Next midnight: ${formatDhakaNextMidnight()}`
      );

      // If missing and not already in progress -> run
      if (payload.autoRunIfMissing && detected.length && !st.sync?.inProgress) {
        // Merge detected with whatever user left in the box
        const mergedText = uniqSortedISO([
          ...detected,
          ...parseISOListFromText(st.datesText || "")
        ]).join(", ");

        await startRunFromEmployeePage(setStatus, mergedText);
      }
    }

    // If tab stays open, schedule reload at next Dhaka midnight
    const ms = msUntilNextDhakaMidnight();
    setTimeout(() => {
      const p = location.pathname.replace(/\/+$/, "");
      const cur = getState();
      if (p === "/employee" && cur.sync?.mode === "running") {
        location.reload();
      }
    }, ms + 400);
  }

  // -------------------------
  // Main init
  // -------------------------
  async function init() {
    await ensureBody();
    const path = location.pathname.replace(/\/+$/, "");

    if (path === "/employee") {
      const { setStatus, toggleBody } = createWidget("employee");

      // If running, auto-open widget (so you can see status)
      const st = getState();
      if (st.sync?.mode === "running" || st.sync?.mode === "paused") toggleBody(true);

      await setupDailyCheckOnEmployeePage(setStatus);
      return;
    }

    if (path === "/employee/standup-form") {
      const { setStatus } = createWidget("standup-form");
      try {
        await runStepOnStandupForm(setStatus);
      } catch (err) {
        setStatus(`❌ Runner error:\n${String(err?.message || err)}`);
        setState((s) => {
          s.sync = s.sync || {};
          s.sync.inProgress = false;
          s.sync.stopRequested = true;
          s.sync.mode = "stopped";
          return s;
        });
      }
      return;
    }
  }

  init();
})();
