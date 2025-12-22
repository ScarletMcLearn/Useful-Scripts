// ==UserScript==
// @name         AGT Time Tracking - Range Auto Entry (skip weekends + exclusions) [date-compare fix]
// @namespace    https://allgentech.io/
// @version      0.6.1
// @description  Navigate calendar month/year, click day tiles, verify modal date (robust), set start/end time, click Create for each date in range (end inclusive). Supports Skip Weekends + Excluded Dates.
// @match        https://allgentech.io/employee/time-tracking*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const MONTHS = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December",
  ];
  const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const PREF_KEY = "agt_tt_auto_entry_prefs_v6_1";

  const HEADER_CHANGE_TIMEOUT_MS = 6000;
  const MAX_CLICKS = 240;

  const MODAL_TIMEOUT_MS = 9000;
  const MODAL_CLOSE_TIMEOUT_MS = 14000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function monthNameToIndex(name) {
    return MONTHS.findIndex((m) => m.toLowerCase() === String(name).toLowerCase());
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

  function ymToSerial(year, monthIdx) {
    return year * 12 + monthIdx;
  }

  function daysInMonth(year, monthIdx) {
    return new Date(year, monthIdx + 1, 0).getDate();
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function toYMDKey(year, monthIdx, day) {
    return `${year}-${pad2(monthIdx + 1)}-${pad2(day)}`;
  }

  function isValidYMD(year, monthIdx, day) {
    const d = new Date(year, monthIdx, day);
    return d.getFullYear() === year && d.getMonth() === monthIdx && d.getDate() === day;
  }

  function dispatchValueEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function savePrefs(p) {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(p));
    } catch {}
  }

  // --- NEW: normalize modal date like "Jan 03, 2024" or "Jan 3, 2024"
  function parseModalDateString(s) {
    const t = String(s || "").trim().replace(/\s+/g, " ");
    // Jan 03, 2024  (day can be 1 or 2 digits)
    const m = t.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/);
    if (!m) return null;

    const mon3 = m[1].toLowerCase();
    const monthIdx = MONTHS_SHORT.map((x) => x.toLowerCase()).indexOf(mon3);
    if (monthIdx < 0) return null;

    const day = Number(m[2]); // handles "03" -> 3
    const year = Number(m[3]);
    if (!isValidYMD(year, monthIdx, day)) return null;

    return { year, monthIdx, day, key: toYMDKey(year, monthIdx, day) };
  }

  function expectedKey(year, monthIdx, day) {
    return toYMDKey(year, monthIdx, day);
  }

  function parseExcludedDatesToSet(text) {
    const set = new Set();
    const raw = String(text || "").trim();
    if (!raw) return set;

    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);

    for (const p of parts) {
      let y, m, d;

      let m1 = p.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
      if (m1) {
        y = Number(m1[1]);
        m = Number(m1[2]) - 1;
        d = Number(m1[3]);
        if (isValidYMD(y, m, d)) set.add(toYMDKey(y, m, d));
        continue;
      }

      let m2 = p.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m2) {
        m = Number(m2[1]) - 1;
        d = Number(m2[2]);
        y = Number(m2[3]);
        if (isValidYMD(y, m, d)) set.add(toYMDKey(y, m, d));
        continue;
      }

      let m3 = p.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
      if (m3) {
        const monthIdx = MONTHS_SHORT.map((x) => x.toLowerCase()).indexOf(m3[1].slice(0,3).toLowerCase());
        if (monthIdx >= 0) {
          y = Number(m3[3]);
          m = monthIdx;
          d = Number(m3[2]);
          if (isValidYMD(y, m, d)) set.add(toYMDKey(y, m, d));
        }
      }
    }

    return set;
  }

  function buildDateRange(startY, startM, startD, endY, endM, endD) {
    if (!isValidYMD(startY, startM, startD)) {
      throw new Error(`Start date is invalid: ${MONTHS[startM]} ${startD}, ${startY}`);
    }
    if (!isValidYMD(endY, endM, endD)) {
      throw new Error(`End date is invalid: ${MONTHS[endM]} ${endD}, ${endY}`);
    }

    const start = new Date(startY, startM, startD);
    const end = new Date(endY, endM, endD);
    if (end < start) throw new Error("End date is before Start date. Please fix the range.");

    const out = [];
    const cur = new Date(start);
    while (cur <= end) {
      out.push({ year: cur.getFullYear(), monthIdx: cur.getMonth(), day: cur.getDate() });
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  function applyFilters(dates, skipWeekends, excludedSet) {
    const kept = [];
    let skippedWeekend = 0;
    let skippedExcluded = 0;

    for (const dt of dates) {
      const jsDate = new Date(dt.year, dt.monthIdx, dt.day);
      const dow = jsDate.getDay(); // 0 Sun .. 6 Sat
      const key = toYMDKey(dt.year, dt.monthIdx, dt.day);

      if (skipWeekends && (dow === 0 || dow === 6)) {
        skippedWeekend++;
        continue;
      }
      if (excludedSet.has(key)) {
        skippedExcluded++;
        continue;
      }
      kept.push(dt);
    }

    return { kept, skippedWeekend, skippedExcluded };
  }

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

  function findDayTile(day) {
    const dayStr = String(day);
    const allDivs = Array.from(document.querySelectorAll("div"));
    const candidates = allDivs.filter((el) => {
      const cls = el.className || "";
      return (
        typeof cls === "string" &&
        cls.includes("min-h-[120px]") &&
        cls.includes("border-gray-200") &&
        cls.includes("rounded-lg") &&
        cls.includes("cursor-pointer")
      );
    });

    const withAddEntry = candidates.find((c) => c.textContent?.includes("Add Entry") && c.textContent?.includes(dayStr));
    if (withAddEntry) return withAddEntry;

    const withDay = candidates.find((c) => Array.from(c.querySelectorAll("div")).some((d) => d.textContent?.trim() === dayStr));
    if (withDay) return withDay;

    const dayLabel = Array.from(document.querySelectorAll("div"))
      .find((d) => d.textContent?.trim() === dayStr && typeof d.className === "string" && d.className.includes("text-sm"));
    if (dayLabel) {
      const tile = dayLabel.closest('div[class*="cursor-pointer"]');
      if (tile) return tile;
    }
    return null;
  }

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

  async function waitForModalClose(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const box = getOpenModalBox();
      if (!box) return true;
      await sleep(120);
    }
    return false;
  }

  function readModalDateValue(modalBox) {
    const dateInput =
      modalBox.querySelector('input[type="text"][placeholder*="Select a date"]') ||
      modalBox.querySelector('input[type="text"].input') ||
      modalBox.querySelector('input[type="text"]');
    return (dateInput?.value || "").trim();
  }

  function setModalTime(modalBox, startTimeHHMM, endTimeHHMM) {
    const startEl = modalBox.querySelector('input[type="time"][name="startTime"]');
    const endEl = modalBox.querySelector('input[type="time"][name="endTime"]');
    if (!startEl || !endEl) throw new Error("Could not find startTime/endTime inputs in modal.");

    startEl.value = startTimeHHMM;
    dispatchValueEvents(startEl);

    endEl.value = endTimeHHMM;
    dispatchValueEvents(endEl);
  }

  function clickModalSubmit(modalBox) {
    const submits = Array.from(modalBox.querySelectorAll('button[type="submit"]'));
    if (!submits.length) throw new Error("Could not find submit button in modal.");
    const lower = (b) => (b.textContent || "").trim().toLowerCase();
    const createBtn = submits.find((b) => lower(b) === "create");
    const updateBtn = submits.find((b) => lower(b) === "update");
    (createBtn || updateBtn || submits[0]).click();
  }

  async function addEntryForDate({ year, monthIdx, day }, startTime, endTime, setStatus) {
    if (abortFlag) throw new Error("STOP_REQUESTED");

    const tile = findDayTile(day);
    if (!tile) throw new Error(`Could not find the day tile for ${day} on the calendar view.`);

    tile.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((r) => requestAnimationFrame(r));
    await sleep(90);
    tile.click();

    const modal = await waitForModalOpen(MODAL_TIMEOUT_MS);
    if (!modal) throw new Error("Modal did not open after clicking day tile.");

    // ✅ Robust compare using YYYY-MM-DD key
    const expected = expectedKey(year, monthIdx, day);
    const actualStr = readModalDateValue(modal);
    const parsed = parseModalDateString(actualStr);
    if (!parsed) throw new Error(`Could not parse modal date: "${actualStr}"`);

    if (parsed.key !== expected) {
      throw new Error(`Modal date mismatch. Expected "${expected}" but found "${parsed.key}" (raw: "${actualStr}")`);
    }

    setStatus(`Filling modal for ${actualStr} (${startTime} → ${endTime})...`);
    setModalTime(modal, startTime, endTime);

    clickModalSubmit(modal);

    const closed = await waitForModalClose(MODAL_CLOSE_TIMEOUT_MS);
    if (!closed) throw new Error("Clicked submit, but modal did not close (maybe validation error?).");

    await sleep(180);
  }

  // ---------------------------
  // Widget UI
  // ---------------------------

  function createWidget() {
    const root = document.createElement("div");
    root.id = "agt-tt-auto-entry-widget";
    root.style.cssText = `
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 999999;
      width: 370px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Noto Sans", "Liberation Sans", sans-serif;
      color: #111827;
    `;

    root.innerHTML = `
      <div style="background: rgba(255,255,255,0.96);border: 1px solid rgba(0,0,0,0.12);border-radius: 12px;box-shadow: 0 10px 25px rgba(0,0,0,0.18);overflow: hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(0,0,0,0.08);">
          <div style="font-weight:700;font-size:13px;">Time Tracking Auto Entry</div>
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

          <div style="font-weight:700;font-size:12px;margin:10px 0 6px;">Start</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">Month
              <select data-field="startMonth" style="padding:6px 8px;border:1px solid rgba(0,0,0,0.18);border-radius:8px;"></select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">Year
              <select data-field="startYear" style="padding:6px 8px;border:1px solid rgba(0,0,0,0.18);border-radius:8px;"></select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">Day
              <select data-field="startDay" style="padding:6px 8px;border:1px solid rgba(0,0,0,0.18);border-radius:8px;"></select>
            </label>
          </div>

          <div style="font-weight:700;font-size:12px;margin:10px 0 6px;">End</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">Month
              <select data-field="endMonth" style="padding:6px 8px;border:1px solid rgba(0,0,0,0.18);border-radius:8px;"></select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">Year
              <select data-field="endYear" style="padding:6px 8px;border:1px solid rgba(0,0,0,0.18);border-radius:8px;"></select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">Day
              <select data-field="endDay" style="padding:6px 8px;border:1px solid rgba(0,0,0,0.18);border-radius:8px;"></select>
            </label>
          </div>

          <div style="margin-top:10px;display:flex;align-items:center;gap:10px;">
            <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;user-select:none;">
              <input type="checkbox" data-field="skipWeekends" />
              Skip weekends
            </label>
          </div>

          <div style="margin-top:10px;">
            <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
              Excluded dates (comma separated)
              <textarea data-field="excludedDates" rows="2" placeholder="e.g. 2024-12-25, 12/31/2024, Dec 22, 2025"
                style="resize:vertical;padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;line-height:1.35;"></textarea>
            </label>
          </div>

          <div style="display:flex;gap:8px;margin-top:10px;">
            <button data-act="start" style="flex:1;padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#111827;color:white;cursor:pointer;font-weight:600;font-size:13px;">Start</button>
            <button data-act="stop"  style="padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#ffffff;color:#111827;cursor:pointer;font-weight:600;font-size:13px;">Stop</button>
          </div>

          <div data-status style="margin-top:10px;padding:8px 10px;border-radius:10px;background: rgba(17,24,39,0.06);font-size:12px;line-height:1.35;min-height: 74px;white-space: pre-wrap;">Ready.</div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const bodyEl = root.querySelector("[data-body]");
    const statusEl = root.querySelector("[data-status]");
    const setStatus = (msg) => { statusEl.textContent = msg; };

    const startTimeEl = root.querySelector('input[data-field="startTime"]');
    const endTimeEl = root.querySelector('input[data-field="endTime"]');

    const startMonthSel = root.querySelector('select[data-field="startMonth"]');
    const startYearSel  = root.querySelector('select[data-field="startYear"]');
    const startDaySel   = root.querySelector('select[data-field="startDay"]');

    const endMonthSel = root.querySelector('select[data-field="endMonth"]');
    const endYearSel  = root.querySelector('select[data-field="endYear"]');
    const endDaySel   = root.querySelector('select[data-field="endDay"]');

    const skipWeekendsCb = root.querySelector('input[data-field="skipWeekends"]');
    const excludedDatesTa = root.querySelector('textarea[data-field="excludedDates"]');

    // populate months
    for (let i = 0; i < MONTHS.length; i++) {
      const opt1 = document.createElement("option");
      opt1.value = String(i);
      opt1.textContent = MONTHS[i];
      startMonthSel.appendChild(opt1);

      const opt2 = document.createElement("option");
      opt2.value = String(i);
      opt2.textContent = MONTHS[i];
      endMonthSel.appendChild(opt2);
    }

    // populate years
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonthIdx = now.getMonth();

    for (let y = currentYear - 10; y <= currentYear + 3; y++) {
      const o1 = document.createElement("option");
      o1.value = String(y);
      o1.textContent = String(y);
      startYearSel.appendChild(o1);

      const o2 = document.createElement("option");
      o2.value = String(y);
      o2.textContent = String(y);
      endYearSel.appendChild(o2);
    }

    // populate days
    for (let d = 1; d <= 31; d++) {
      const o1 = document.createElement("option");
      o1.value = String(d);
      o1.textContent = String(d);
      startDaySel.appendChild(o1);

      const o2 = document.createElement("option");
      o2.value = String(d);
      o2.textContent = String(d);
      endDaySel.appendChild(o2);
    }

    // defaults
    const defaultStartYear = currentYear;
    const defaultStartMonthIdx = currentMonthIdx;
    const defaultStartDay = 1;

    const defaultEndYear = currentYear;
    const defaultEndMonthIdx = currentMonthIdx;
    const defaultEndDay = daysInMonth(defaultEndYear, defaultEndMonthIdx);

    const prefs = loadPrefs();

    startTimeEl.value = String(prefs?.startTime ?? "09:00");
    endTimeEl.value = String(prefs?.endTime ?? "17:00");

    startMonthSel.value = String(prefs?.startMonthIdx ?? defaultStartMonthIdx);
    startYearSel.value  = String(prefs?.startYear ?? defaultStartYear);
    startDaySel.value   = String(prefs?.startDay ?? defaultStartDay);

    endMonthSel.value = String(prefs?.endMonthIdx ?? defaultEndMonthIdx);
    endYearSel.value  = String(prefs?.endYear ?? defaultEndYear);
    endDaySel.value   = String(prefs?.endDay ?? defaultEndDay);

    skipWeekendsCb.checked = Boolean(prefs?.skipWeekends ?? false);
    excludedDatesTa.value = String(prefs?.excludedDates ?? "");

    function persist() {
      savePrefs({
        startTime: String(startTimeEl.value || "09:00"),
        endTime: String(endTimeEl.value || "17:00"),
        startMonthIdx: Number(startMonthSel.value),
        startYear: Number(startYearSel.value),
        startDay: Number(startDaySel.value),
        endMonthIdx: Number(endMonthSel.value),
        endYear: Number(endYearSel.value),
        endDay: Number(endDaySel.value),
        skipWeekends: Boolean(skipWeekendsCb.checked),
        excludedDates: String(excludedDatesTa.value || ""),
      });
    }

    function syncEndDayToLastOfMonth() {
      const y = Number(endYearSel.value);
      const m = Number(endMonthSel.value);
      endDaySel.value = String(daysInMonth(y, m));
    }

    root.addEventListener("change", (e) => {
      const t = e.target;
      if (t === endMonthSel || t === endYearSel) syncEndDayToLastOfMonth();
      persist();
    });
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
      persist();

      const startTime = String(startTimeEl.value || "09:00");
      const endTime = String(endTimeEl.value || "17:00");

      const startMonthIdx = Number(startMonthSel.value);
      const startYear = Number(startYearSel.value);
      const startDay = Number(startDaySel.value);

      const endMonthIdx = Number(endMonthSel.value);
      const endYear = Number(endYearSel.value);
      const endDay = Number(endDaySel.value);

      const skipWeekends = Boolean(skipWeekendsCb.checked);
      const excludedSet = parseExcludedDatesToSet(excludedDatesTa.value);

      try {
        const allDates = buildDateRange(startYear, startMonthIdx, startDay, endYear, endMonthIdx, endDay);
        const { kept, skippedWeekend, skippedExcluded } = applyFilters(allDates, skipWeekends, excludedSet);

        setStatus(
          `Total in range: ${allDates.length}\n` +
          `Will process: ${kept.length}\n` +
          `Skipped weekends: ${skippedWeekend}\n` +
          `Skipped excluded: ${skippedExcluded}\n` +
          `Time: ${startTime} → ${endTime}\n\n` +
          `Navigating to start month/year...`
        );

        if (!kept.length) return;

        await navigateTo(startYear, startMonthIdx, (m) => setStatus(`Navigating to start...\n${m}`));

        for (let i = 0; i < kept.length; i++) {
          if (abortFlag) throw new Error("STOP_REQUESTED");

          const d = kept[i];
          const ymd = toYMDKey(d.year, d.monthIdx, d.day);

          await navigateTo(d.year, d.monthIdx, (m) => setStatus(`Working ${i + 1}/${kept.length}\n${m}\nDate: ${ymd}`));

          await addEntryForDate(d, startTime, endTime, (msg) => setStatus(`Working ${i + 1}/${kept.length}\n${msg}\nDate: ${ymd}`));

          setStatus(`✅ Created entry for ${ymd} (${startTime} → ${endTime})\nProgress: ${i + 1}/${kept.length}`);
          await sleep(200);
        }

        setStatus(
          `✅ Done.\n` +
          `Created: ${kept.length}\n` +
          `Total in range: ${allDates.length}\n` +
          `Skipped weekends: ${skippedWeekend}\n` +
          `Skipped excluded: ${skippedExcluded}\n` +
          `Time: ${startTime} → ${endTime}`
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

  if (document.getElementById("agt-tt-auto-entry-widget")) return;
  setTimeout(createWidget, 600);
})();
