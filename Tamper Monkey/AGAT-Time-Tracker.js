// ==UserScript==
// @name         AGT Time Tracking - Month→Today Auto Fill (1am→5pm + Overtime Auto-Tick/Confirm)
// @namespace    https://allgentech.io/
// @version      0.4.0
// @description  Auto-fill entries from 1st of current month to today; default 01:00→17:00; skip weekends default ON; excluded dates textarea; only days with "Add Entry". If overtime appears: auto-tick all projects + approvals, and optionally auto-confirm overtime. If "Are you a time traveler?" error appears while submitting, reload page and treat as complete.
// @match        https://allgentech.io/employee/time-tracking*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  // -----------------------------
  // Defaults (forced on first run; UI still editable)
  // -----------------------------
  const DEFAULT_START_TIME = "01:00";
  const DEFAULT_END_TIME = "17:00";
  const DEFAULT_SKIP_WEEKENDS = true;

  // ✅ Overtime automation defaults (ON by default)
  const DEFAULT_AUTO_TICK_OVERTIME = true;     // ticks all overtime checkboxes (projects + approvals)
  const DEFAULT_AUTO_CONFIRM_OVERTIME = true;  // clicks "Confirm Overtime" (you asked default ON)

  // ✅ Bumped KEY so prior saved prefs won't keep overtime toggles OFF
  const PREF_KEY = "agt_tt_month_to_today_prefs_v3";

  const MODAL_TIMEOUT_MS = 12000;
  const MODAL_CLOSE_TIMEOUT_MS = 15 * 60 * 1000; // allow time for manual overtime confirmations
  const HEADER_CHANGE_TIMEOUT_MS = 6000;
  const MAX_CLICKS = 240;

  const TIME_TRAVELER_TEXT = "Are you a time traveler? Please select a valid date";
  const TIME_TRAVELER_SESSION_KEY = "agt_tt_time_traveler_complete";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad2 = (n) => String(n).padStart(2, "0");
  const toYMDKey = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

  const MONTHS = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December",
  ];
  const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // -----------------------------
  // Storage
  // -----------------------------
  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function savePrefs(p) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch {}
  }

  // -----------------------------
  // Date parsing & exclusions
  // -----------------------------
  function isValidYMD(year, monthIdx, day) {
    const d = new Date(year, monthIdx, day);
    return d.getFullYear() === year && d.getMonth() === monthIdx && d.getDate() === day;
  }

  function parseExcludedDatesToSet(text) {
    const set = new Set();
    const raw = String(text || "").trim();
    if (!raw) return set;

    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);

    for (const p of parts) {
      let y, m, d;

      // YYYY-MM-DD or YYYY/MM/DD
      const m1 = p.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
      if (m1) {
        y = Number(m1[1]); m = Number(m1[2]) - 1; d = Number(m1[3]);
        if (isValidYMD(y, m, d)) set.add(toYMDKey(y, m, d));
        continue;
      }

      // MM/DD/YYYY
      const m2 = p.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m2) {
        m = Number(m2[1]) - 1; d = Number(m2[2]); y = Number(m2[3]);
        if (isValidYMD(y, m, d)) set.add(toYMDKey(y, m, d));
        continue;
      }

      // "Dec 22, 2025" or "December 22, 2025"
      const m3 = p.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
      if (m3) {
        const mon3 = m3[1].slice(0,3).toLowerCase();
        const monthIdx = MONTHS_SHORT.map((x) => x.toLowerCase()).indexOf(mon3);
        if (monthIdx >= 0) {
          y = Number(m3[3]); m = monthIdx; d = Number(m3[2]);
          if (isValidYMD(y, m, d)) set.add(toYMDKey(y, m, d));
        }
      }
    }
    return set;
  }

  // Modal date can be:
  // - "Jan 7, 2026"
  // - "Jan 07, 2026"
  // - sometimes "2026-01-07" (fallback)
  function parseModalDateString(s) {
    const t = String(s || "").trim().replace(/\s+/g, " ");

    let m = t.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/);
    if (m) {
      const mon3 = m[1].toLowerCase();
      const monthIdx = MONTHS_SHORT.map((x) => x.toLowerCase()).indexOf(mon3);
      if (monthIdx < 0) return null;
      const day = Number(m[2]);
      const year = Number(m[3]);
      if (!isValidYMD(year, monthIdx, day)) return null;
      return { year, monthIdx, day, key: toYMDKey(year, monthIdx, day), raw: t };
    }

    m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const year = Number(m[1]);
      const monthIdx = Number(m[2]) - 1;
      const day = Number(m[3]);
      if (!isValidYMD(year, monthIdx, day)) return null;
      return { year, monthIdx, day, key: toYMDKey(year, monthIdx, day), raw: t };
    }

    return null;
  }

  // ✅ Start of month → today (current month)
  function buildDateRangeMonthToToday(skipWeekends, excludedSet) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const today = now.getDate();

    const out = [];
    for (let d = 1; d <= today; d++) {
      const jsDate = new Date(y, m, d);
      const dow = jsDate.getDay(); // 0 Sun .. 6 Sat
      const key = toYMDKey(y, m, d);

      if (skipWeekends && (dow === 0 || dow === 6)) continue;
      if (excludedSet.has(key)) continue;

      out.push({ year: y, monthIdx: m, day: d });
    }
    return out;
  }

  // -----------------------------
  // Calendar navigation
  // -----------------------------
  function monthNameToIndex(name) {
    return MONTHS.findIndex((mm) => mm.toLowerCase() === String(name).toLowerCase());
  }

  function parseMonthYear(text) {
    const t = String(text || "").trim().replace(/\s+/g, " ");
    const m = t.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (!m) return null;
    const monthIdx = monthNameToIndex(m[1]);
    const year = Number(m[2]);
    if (monthIdx < 0 || !Number.isFinite(year)) return null;
    return { monthIdx, year, raw: t };
  }

  function ymToSerial(year, monthIdx) { return year * 12 + monthIdx; }

  function findMonthHeaderEl() {
    const headers = Array.from(document.querySelectorAll("h1,h2,h3"));
    for (const h of headers) {
      if (parseMonthYear(h.textContent)) return h;
    }
    return null;
  }

  function findNavButtonsNearHeader(headerEl) {
    const parent = headerEl?.closest("div");
    if (!parent) return null;

    let container = parent;
    for (let i = 0; i < 7 && container; i++) {
      const btns = Array.from(container.querySelectorAll("button"));
      if (btns.length >= 2) {
        const svgBtns = btns.filter((b) => b.querySelector("svg"));
        if (svgBtns.length >= 2) return { prevBtn: svgBtns[0], nextBtn: svgBtns[1] };
        return { prevBtn: btns[0], nextBtn: btns[1] };
      }
      container = container.parentElement;
    }
    return null;
  }

  async function waitForHeaderChange(headerEl, oldText, timeoutMs) {
    const start = Date.now();
    const old = String(oldText || "").trim();
    if (!headerEl) return false;
    if (String(headerEl.textContent || "").trim() !== old) return true;

    return await new Promise((resolve) => {
      let done = false;

      const obs = new MutationObserver(() => {
        const now = String(headerEl.textContent || "").trim();
        if (now !== old) {
          done = true;
          obs.disconnect();
          resolve(true);
        }
      });

      obs.observe(headerEl, { childList: true, characterData: true, subtree: true });

      const tick = () => {
        if (done) return;
        if (Date.now() - start >= timeoutMs) {
          obs.disconnect();
          resolve(false);
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  let abortFlag = false;

  async function navigateTo(targetYear, targetMonthIdx, setStatus) {
    const header = findMonthHeaderEl();
    if (!header) throw new Error("Could not find Month/Year header.");

    const nav = findNavButtonsNearHeader(header);
    if (!nav?.prevBtn || !nav?.nextBtn) throw new Error("Could not find prev/next arrow buttons near header.");

    const currentParsed = parseMonthYear(header.textContent);
    if (!currentParsed) throw new Error(`Header format unexpected: "${String(header.textContent || "").trim()}"`);

    const delta = ymToSerial(targetYear, targetMonthIdx) - ymToSerial(currentParsed.year, currentParsed.monthIdx);
    if (delta === 0) return;

    if (Math.abs(delta) > MAX_CLICKS) throw new Error(`Too far to navigate (${Math.abs(delta)} clicks). Safety limit is ${MAX_CLICKS}.`);

    const direction = delta > 0 ? "next" : "prev";
    const clicksNeeded = Math.abs(delta);

    let lastHeaderText = String(header.textContent || "").trim();

    for (let i = 1; i <= clicksNeeded; i++) {
      if (abortFlag) throw new Error("STOP_REQUESTED");

      const headerNow = findMonthHeaderEl();
      const navNow = findNavButtonsNearHeader(headerNow);
      const btnToClick = direction === "next" ? navNow?.nextBtn : navNow?.prevBtn;
      if (!headerNow || !btnToClick) throw new Error("UI changed while navigating (header/buttons not found).");

      btnToClick.click();

      const changed = await waitForHeaderChange(headerNow, lastHeaderText, HEADER_CHANGE_TIMEOUT_MS);
      const newText = String(headerNow.textContent || "").trim();
      if (!changed) {
        throw new Error(
          `Clicked (${i}/${clicksNeeded}) but header did not change within ${HEADER_CHANGE_TIMEOUT_MS}ms.\n` +
          `Last: "${lastHeaderText}"\nCurrent: "${newText}"`
        );
      }
      lastHeaderText = newText;

      const p = parseMonthYear(newText);
      setStatus(p ? `Navigating... (${i}/${clicksNeeded}) Now: ${MONTHS[p.monthIdx]} ${p.year}` : `Navigating... (${i}/${clicksNeeded}) Header: ${newText}`);
      await sleep(120);
    }
  }

  // -----------------------------
  // Tile finding (exact day match + Add Entry)
  // -----------------------------
  function getCalendarTileCandidates() {
    const allDivs = Array.from(document.querySelectorAll("div"));
    return allDivs.filter((el) => {
      const cls = el.className || "";
      return (
        typeof cls === "string" &&
        cls.includes("min-h-[120px]") &&
        cls.includes("border-gray-200") &&
        cls.includes("rounded-lg") &&
        cls.includes("cursor-pointer") // grey prev/next month tiles don’t have cursor-pointer in your markup
      );
    });
  }

  function getTileDayNumber(tile) {
    const el =
      tile.querySelector('div.text-sm.font-medium.mb-2') ||
      tile.querySelector('div[class*="text-sm"][class*="font-medium"][class*="mb-2"]');

    const n = Number((el?.textContent || "").trim());
    return Number.isFinite(n) ? n : null;
  }

  function findDayTilesWithAddEntry(day) {
    const want = Number(day);
    return getCalendarTileCandidates().filter((t) => {
      if (!(t.textContent || "").includes("Add Entry")) return false;
      const n = getTileDayNumber(t);
      return n === want; // exact match: 7 != 17 != 27
    });
  }

  // -----------------------------
  // Modal helpers
  // -----------------------------
  function getOpenModalBox() {
    const boxes = Array.from(document.querySelectorAll(".modal-box"));
    if (!boxes.length) return null;
    for (const b of boxes) {
      if (b.querySelector('input[type="time"][name="startTime"]') && b.querySelector('input[type="time"][name="endTime"]')) {
        return b;
      }
    }
    return boxes[0];
  }

  async function waitForModalOpen(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const box = getOpenModalBox();
      if (box) return box;
      await sleep(100);
    }
    return null;
  }

  function readModalDateValue(modalBox) {
    const dateInput =
      modalBox.querySelector('input[type="text"][placeholder*="Select a date"]') ||
      modalBox.querySelector('input[type="text"].input') ||
      modalBox.querySelector('input[type="text"]');
    return (dateInput?.value || "").trim();
  }

  function timeTravelerErrorPresent(modalBox) {
    if (!modalBox) return false;
    const spans = Array.from(
      modalBox.querySelectorAll("span.label-text-alt.text-error, span.text-error, .label-text-alt.text-error, .text-error")
    );
    return spans.some((s) => (s.textContent || "").includes(TIME_TRAVELER_TEXT));
  }

  let timeTravelerReloadTriggered = false;

  function triggerTimeTravelerReload(modalBox, context = {}) {
    if (timeTravelerReloadTriggered) return;
    timeTravelerReloadTriggered = true;
    abortFlag = true;

    try {
      const payload = {
        at: new Date().toISOString(),
        dateValue: readModalDateValue(modalBox),
        context,
      };
      sessionStorage.setItem(TIME_TRAVELER_SESSION_KEY, JSON.stringify(payload));
    } catch {}

    try {
      location.reload();
    } catch {
      // If reload fails for any reason, we at least stop
    }
  }

  async function waitForModalCloseOrTimeTraveler(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const box = getOpenModalBox();
      if (!box) return { closed: true };

      if (timeTravelerErrorPresent(box)) {
        triggerTimeTravelerReload(box, { stage: "waiting_for_close" });
        return { closed: false, timeTraveler: true };
      }

      await sleep(150);
    }
    return { closed: false, timeout: true };
  }

  // React-controlled inputs: must use native value setter
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setModalTime(modalBox, startTimeHHMM, endTimeHHMM) {
    const startEl = modalBox.querySelector('input[type="time"][name="startTime"]');
    const endEl = modalBox.querySelector('input[type="time"][name="endTime"]');
    if (!startEl || !endEl) throw new Error("Could not find startTime/endTime inputs in modal.");

    setNativeValue(startEl, startTimeHHMM);
    setNativeValue(endEl, endTimeHHMM);
  }

  function clickModalSubmit(modalBox) {
    const submits = Array.from(modalBox.querySelectorAll('button[type="submit"]'));
    if (!submits.length) throw new Error("Could not find submit button in modal.");
    const lower = (b) => (b.textContent || "").trim().toLowerCase();
    const createBtn = submits.find((b) => lower(b) === "create");
    const updateBtn = submits.find((b) => lower(b) === "update");
    (createBtn || updateBtn || submits[0]).click();
  }

  function findProceedWithOvertimeButton(modalBox) {
    const btns = Array.from(modalBox.querySelectorAll('button[type="button"]'));
    return btns.find((b) => (b.textContent || "").trim().toLowerCase() === "proceed with overtime");
  }

  function overtimePanelPresent(modalBox) {
    // alert panel includes "Overtime Detected!"
    const alerts = Array.from(modalBox.querySelectorAll(".alert"));
    return alerts.some((a) => (a.textContent || "").includes("Overtime Detected!"));
  }

  // Overtime panel + auto-tick + auto-confirm helpers
  function findOvertimePanel(modalBox) {
    const amber = modalBox.querySelector(".alert.bg-amber-50");
    if (amber && (amber.textContent || "").includes("Overtime Detected")) return amber;

    const all = Array.from(modalBox.querySelectorAll("div,section,article"));
    return all.find((el) =>
      (el.textContent || "").includes("Please confirm the following to proceed with overtime:")
    ) || null;
  }

  async function waitForOvertimePanel(modalBox, timeoutMs = 2500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const p = findOvertimePanel(modalBox);
      if (p) return p;
      await sleep(100);
    }
    return null;
  }

  function clickCheckbox(el) {
    if (!el) return false;
    if (el.disabled) return false;

    const id = el.getAttribute("id");
    if (id) {
      const lbl = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lbl) {
        lbl.click();
        return true;
      }
    }
    el.click();
    return true;
  }

  async function autoTickOvertimeCheckboxes(modalBox, setStatus) {
    const panel = await waitForOvertimePanel(modalBox, 2500);
    if (!panel) {
      setStatus?.("⚠️ Overtime panel not found to auto-tick.");
      return { found: 0, ticked: 0 };
    }

    const boxes = Array.from(panel.querySelectorAll('input[type="checkbox"]'));
    let ticked = 0;

    for (const cb of boxes) {
      if (timeTravelerErrorPresent(modalBox)) {
        triggerTimeTravelerReload(modalBox, { stage: "auto_tick" });
        return { found: boxes.length, ticked };
      }
      if (!cb.checked) {
        clickCheckbox(cb);
        ticked++;
        await sleep(80);
      }
    }

    return { found: boxes.length, ticked };
  }

  function clickConfirmOvertime(modalBox) {
    const btns = Array.from(modalBox.querySelectorAll('button[type="submit"]'));
    const target = btns.find((b) => (b.textContent || "").trim().toLowerCase() === "confirm overtime");
    (target || btns[0])?.click();
  }

  async function openCorrectModalForDate({ year, monthIdx, day }) {
    const expectedKey = toYMDKey(year, monthIdx, day);
    const candidates = findDayTilesWithAddEntry(day);
    if (!candidates.length) return { modal: null, reason: "NO_ADD_ENTRY" };

    for (const tile of candidates) {
      if (abortFlag) throw new Error("STOP_REQUESTED");

      tile.scrollIntoView({ block: "center", inline: "center" });
      await new Promise((r) => requestAnimationFrame(r));
      await sleep(80);
      tile.click();

      const modal = await waitForModalOpen(MODAL_TIMEOUT_MS);
      if (!modal) continue;

      const actualStr = readModalDateValue(modal);
      const parsed = parseModalDateString(actualStr);

      if (parsed && parsed.key === expectedKey) {
        return { modal, reason: "OK" };
      }

      // Wrong tile (duplicate day from another month) -> close and try next
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(150);
      await waitForModalCloseOrTimeTraveler(2500);
      await sleep(80);
    }

    return { modal: null, reason: "DATE_MISMATCH" };
  }

  async function addEntryForDate(dt, startTime, endTime, autoTickOvertime, autoConfirmOvertime, setStatus) {
    if (abortFlag) throw new Error("STOP_REQUESTED");

    const ymd = toYMDKey(dt.year, dt.monthIdx, dt.day);
    const opened = await openCorrectModalForDate(dt);

    if (!opened.modal) {
      if (opened.reason === "NO_ADD_ENTRY") {
        return { skipped: true, ymd, why: "NO_ADD_ENTRY" };
      }
      throw new Error(`Could not open correct modal for ${ymd}. Reason: ${opened.reason}`);
    }

    const modal = opened.modal;

    // verify date
    const actualStr = readModalDateValue(modal);
    const parsed = parseModalDateString(actualStr);
    if (!parsed || parsed.key !== ymd) {
      throw new Error(`Modal date mismatch. Expected "${ymd}" but found "${parsed?.key || "UNPARSEABLE"}" (raw: "${actualStr}")`);
    }

    // fill time
    setStatus(`Filling ${ymd}: ${startTime} → ${endTime}`);
    setModalTime(modal, startTime, endTime);
    await sleep(250);

    // auto-click "Proceed with Overtime" if present
    const proceedBtn = findProceedWithOvertimeButton(modal);
    if (proceedBtn) {
      proceedBtn.click();
      await sleep(350);
    }

    // If overtime panel is present...
    if (overtimePanelPresent(modal)) {
      if (autoTickOvertime) {
        setStatus(`⚠️ Overtime detected for ${ymd}.\nAuto-ticking overtime checkboxes...`);
        const res = await autoTickOvertimeCheckboxes(modal, setStatus);
        await sleep(200);
        setStatus(
          `⚠️ Overtime detected for ${ymd}.\n` +
          `Auto-ticked: ${res.ticked}/${res.found} checkboxes.\n\n` +
          (autoConfirmOvertime
            ? `Auto-confirm is ON. Attempting to submit overtime...`
            : `Auto-confirm is OFF. Review selections, then submit manually if you want.`)
        );
      } else {
        setStatus(
          `⚠️ Overtime detected for ${ymd}.\n` +
          `Auto-tick is OFF.\n\n` +
          `Review projects + approvals manually.`
        );
      }

      if (autoConfirmOvertime) {
        await sleep(250);
        clickConfirmOvertime(modal);

        // ✅ While waiting, if time traveler error appears => reload + complete
        const w = await waitForModalCloseOrTimeTraveler(20000);
        if (w.timeTraveler) return { skipped: false, ymd, why: "TIME_TRAVELER_RELOAD" };
        if (!w.closed) throw new Error(`Clicked "Confirm Overtime" for ${ymd}, but modal did not close (validation error?).`);

        await sleep(150);
        return { skipped: false, ymd, why: "AUTO_CONFIRMED_OVERTIME" };
      }

      // Manual close path (still watching for time traveler error)
      setStatus(
        `⚠️ Overtime detected for ${ymd}.\n\n` +
        (autoTickOvertime ? `I ticked all projects + approvals (if found).\n\n` : ``) +
        `Now YOU may:\n` +
        `• Review selections\n` +
        `• Click Confirm Overtime (or Cancel)\n\n` +
        `Waiting for modal to close...`
      );

      const w = await waitForModalCloseOrTimeTraveler(MODAL_CLOSE_TIMEOUT_MS);
      if (w.timeTraveler) return { skipped: false, ymd, why: "TIME_TRAVELER_RELOAD" };
      if (!w.closed) throw new Error(`Timed out waiting for overtime modal to close for ${ymd}.`);

      await sleep(150);
      return { skipped: false, ymd, why: autoTickOvertime ? "MANUAL_OVERTIME_AFTER_AUTOTICK" : "MANUAL_OVERTIME" };
    }

    // no overtime -> auto submit
    clickModalSubmit(modal);

    // ✅ Watch for time traveler error while waiting for close
    const w = await waitForModalCloseOrTimeTraveler(20000);
    if (w.timeTraveler) return { skipped: false, ymd, why: "TIME_TRAVELER_RELOAD" };
    if (!w.closed) throw new Error(`Clicked submit for ${ymd}, but modal did not close (validation error?).`);

    await sleep(150);
    return { skipped: false, ymd, why: "AUTO_SUBMITTED" };
  }

  // -----------------------------
  // Widget UI
  // -----------------------------
  function createWidget() {
    const root = document.createElement("div");
    root.id = "agt-tt-month-to-today-widget";
    root.style.cssText = `
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 999999;
      width: 360px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Noto Sans", sans-serif;
      color: #111827;
    `;

    root.innerHTML = `
      <div style="background: rgba(255,255,255,0.96);border: 1px solid rgba(0,0,0,0.12);border-radius: 12px;box-shadow: 0 10px 25px rgba(0,0,0,0.18);overflow: hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(0,0,0,0.08);">
          <div style="font-weight:700;font-size:13px;">Month → Today Auto Fill</div>
          <button data-act="toggle" title="Minimize" style="border:none;background:transparent;cursor:pointer;font-size:14px;line-height:1;padding:4px 8px;border-radius:8px;">—</button>
        </div>

        <div data-body style="padding:10px 12px;display:block;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">
              Start Time
              <input data-field="startTime" type="time" style="padding:6px 8px;border:1px solid rgba(0,0,0,0.18);border-radius:8px;font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">
              End Time
              <input data-field="endTime" type="time" style="padding:6px 8px;border:1px solid rgba(0,0,0,0.18);border-radius:8px;font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;">
            </label>
          </div>

          <div style="margin-top:10px;display:flex;align-items:center;gap:10px;">
            <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;user-select:none;">
              <input type="checkbox" data-field="skipWeekends" />
              Skip weekends
            </label>
          </div>

          <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">
            <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;user-select:none;">
              <input type="checkbox" data-field="autoTickOvertime" />
              Auto-tick overtime projects + approvals
            </label>

            <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;user-select:none;">
              <input type="checkbox" data-field="autoConfirmOvertime" />
              Auto-confirm overtime
            </label>
          </div>

          <div style="margin-top:10px;">
            <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
              Excluded dates (comma separated)
              <textarea data-field="excludedDates" rows="2" placeholder="e.g. 2026-01-02, 01/15/2026, Jan 20, 2026"
                style="resize:vertical;padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;line-height:1.35;"></textarea>
            </label>
          </div>

          <div style="display:flex;gap:8px;margin-top:10px;">
            <button data-act="start" style="flex:1;padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#111827;color:white;cursor:pointer;font-weight:600;font-size:13px;">Start</button>
            <button data-act="stop"  style="padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#ffffff;color:#111827;cursor:pointer;font-weight:600;font-size:13px;">Stop</button>
          </div>

          <div data-status style="margin-top:10px;padding:8px 10px;border-radius:10px;background: rgba(17,24,39,0.06);font-size:12px;line-height:1.35;min-height: 96px;white-space: pre-wrap;">Ready.</div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const bodyEl = root.querySelector("[data-body]");
    const statusEl = root.querySelector("[data-status]");
    const setStatus = (msg) => { statusEl.textContent = msg; };

    // Show completion note after reload (time traveler)
    try {
      const raw = sessionStorage.getItem(TIME_TRAVELER_SESSION_KEY);
      if (raw) {
        sessionStorage.removeItem(TIME_TRAVELER_SESSION_KEY);
        const info = JSON.parse(raw);
        setStatus(
          `✅ Considered complete.\n` +
          `Detected: "${TIME_TRAVELER_TEXT}"\n` +
          `Reloaded page.\n\n` +
          `Modal date value was: ${info?.dateValue || "(unknown)"}\n` +
          `Time: ${info?.at || "(unknown)"}`
        );
      }
    } catch {}

    const startTimeEl = root.querySelector('input[data-field="startTime"]');
    const endTimeEl = root.querySelector('input[data-field="endTime"]');
    const skipWeekendsCb = root.querySelector('input[data-field="skipWeekends"]');
    const excludedDatesTa = root.querySelector('textarea[data-field="excludedDates"]');

    const autoTickOvertimeCb = root.querySelector('input[data-field="autoTickOvertime"]');
    const autoConfirmOvertimeCb = root.querySelector('input[data-field="autoConfirmOvertime"]');

    // Load prefs (but use defaults if missing)
    const prefs = loadPrefs();
    startTimeEl.value = String(prefs?.startTime ?? DEFAULT_START_TIME);
    endTimeEl.value = String(prefs?.endTime ?? DEFAULT_END_TIME);
    skipWeekendsCb.checked = Boolean(prefs?.skipWeekends ?? DEFAULT_SKIP_WEEKENDS);
    excludedDatesTa.value = String(prefs?.excludedDates ?? "");

    autoTickOvertimeCb.checked = Boolean(prefs?.autoTickOvertime ?? DEFAULT_AUTO_TICK_OVERTIME);
    autoConfirmOvertimeCb.checked = Boolean(prefs?.autoConfirmOvertime ?? DEFAULT_AUTO_CONFIRM_OVERTIME);

    function persist() {
      savePrefs({
        startTime: String(startTimeEl.value || DEFAULT_START_TIME),
        endTime: String(endTimeEl.value || DEFAULT_END_TIME),
        skipWeekends: Boolean(skipWeekendsCb.checked),
        excludedDates: String(excludedDatesTa.value || ""),

        autoTickOvertime: Boolean(autoTickOvertimeCb.checked),
        autoConfirmOvertime: Boolean(autoConfirmOvertimeCb.checked),
      });
    }

    root.addEventListener("change", persist);
    root.addEventListener("input", persist);

    root.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;

      const act = btn.getAttribute("data-act");

      if (act === "toggle") {
        const isHidden = bodyEl.style.display === "none";
        bodyEl.style.display = isHidden ? "block" : "none";
        btn.textContent = isHidden ? "—" : "+";
        btn.title = isHidden ? "Minimize" : "Expand";
        return;
      }

      if (act === "stop") {
        abortFlag = true;
        setStatus("Stop requested. It will stop after the current step.");
        return;
      }

      if (act !== "start") return;

      abortFlag = false;
      timeTravelerReloadTriggered = false;
      persist();

      const startTime = String(startTimeEl.value || DEFAULT_START_TIME);
      const endTime = String(endTimeEl.value || DEFAULT_END_TIME);
      const skipWeekends = Boolean(skipWeekendsCb.checked);
      const excludedSet = parseExcludedDatesToSet(excludedDatesTa.value);

      const autoTickOvertime = Boolean(autoTickOvertimeCb.checked);
      const autoConfirmOvertime = Boolean(autoConfirmOvertimeCb.checked);

      const now = new Date();
      const targetYear = now.getFullYear();
      const targetMonthIdx = now.getMonth();
      const today = now.getDate();

      try {
        const range = buildDateRangeMonthToToday(skipWeekends, excludedSet);

        setStatus(
          `Debug local date: ${now.toString()}\n\n` +
          `Range: ${toYMDKey(targetYear, targetMonthIdx, 1)} → ${toYMDKey(targetYear, targetMonthIdx, today)}\n` +
          `Candidates (after filters): ${range.length}\n` +
          `Time to set: ${startTime} → ${endTime}\n` +
          `Overtime: auto-tick=${autoTickOvertime ? "ON" : "OFF"}, auto-confirm=${autoConfirmOvertime ? "ON" : "OFF"}\n\n` +
          `Navigating to current month...`
        );

        await navigateTo(targetYear, targetMonthIdx, (m) => setStatus(`Navigating...\n${m}`));

        let processed = 0;
        let skippedNoAdd = 0;

        for (let i = 0; i < range.length; i++) {
          if (abortFlag) throw new Error("STOP_REQUESTED");

          const dt = range[i];
          const ymd = toYMDKey(dt.year, dt.monthIdx, dt.day);

          const result = await addEntryForDate(
            dt,
            startTime,
            endTime,
            autoTickOvertime,
            autoConfirmOvertime,
            (msg) => setStatus(`Working ${i + 1}/${range.length}\n${msg}`)
          );

          // If we triggered reload due to time traveler, treat as complete and stop.
          if (result?.why === "TIME_TRAVELER_RELOAD") {
            // Reload should already be happening; just exit.
            return;
          }

          if (result?.why === "NO_ADD_ENTRY") skippedNoAdd++;
          else processed++;

          setStatus(
            `Progress: ${i + 1}/${range.length}\n` +
            `Processed: ${processed}\n` +
            `Skipped (no Add Entry): ${skippedNoAdd}\n` +
            `Last: ${ymd} (${result?.why || "OK"})\n\n` +
            `Time to set: ${startTime} → ${endTime}\n` +
            `Overtime: auto-tick=${autoTickOvertime ? "ON" : "OFF"}, auto-confirm=${autoConfirmOvertime ? "ON" : "OFF"}`
          );

          await sleep(200);
        }

        setStatus(
          `✅ Done.\n` +
          `Processed: ${processed}\n` +
          `Skipped (no Add Entry): ${skippedNoAdd}\n` +
          `Range: ${toYMDKey(targetYear, targetMonthIdx, 1)} → ${toYMDKey(targetYear, targetMonthIdx, today)}\n` +
          `Time set: ${startTime} → ${endTime}\n` +
          `Overtime: auto-tick=${autoTickOvertime ? "ON" : "OFF"}, auto-confirm=${autoConfirmOvertime ? "ON" : "OFF"}`
        );
      } catch (err) {
        if (String(err?.message) === "STOP_REQUESTED") {
          setStatus(`🛑 Stopped by you.\nCurrently showing: ${String(findMonthHeaderEl()?.textContent || "").trim()}`);
          return;
        }
        setStatus(`❌ Error:\n${err?.message || String(err)}`);
      }
    });
  }

  if (document.getElementById("agt-tt-month-to-today-widget")) return;
  setTimeout(createWidget, 600);
})();
