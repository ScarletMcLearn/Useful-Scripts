// ==UserScript==
// @name         AGT - Missing Standup Autofill Helper (with exclude dates) [FIXED]
// @namespace    https://allgentech.io/
// @version      1.1.1
// @description  On /employee: extract missing standup dates from Pending Tasks, show an expandable widget with defaults + exclude-dates. On /employee/standup-form: auto-fill the form for a missing date (skipping excluded dates). Does NOT submit.
// @match        https://allgentech.io/employee*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const STORE_KEY = "agt_missing_standup_autofill_v1_1_1";

  // -------------------------
  // Small utils
  // -------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  async function ensureBody() {
    if (document.body) return;
    for (let i = 0; i < 80; i++) {
      if (document.body) return;
      await sleep(50);
    }
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

  function safeJsonParse(raw) {
    try { return JSON.parse(raw); } catch { return null; }
  }

  function loadState() {
    return safeJsonParse(localStorage.getItem(STORE_KEY)) || {};
  }

  function saveState(state) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
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

  function pad2(n) { return String(n).padStart(2, "0"); }

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

  /**
   * Exclude dates parser:
   * Accepts comma-separated:
   *  - dd-mm-yy, mm-dd-yy
   *  - dd-mm-yyyy, mm-dd-yyyy
   * Separator "-" or "/"
   *
   * Ambiguity rule when both parts <= 12:
   *  - default assumes MM-DD (common "12-31-2024")
   *  - if first > 12 -> DD-MM
   *  - if second > 12 -> MM-DD
   */
  function parseExcludeDatesToSet(raw) {
    const set = new Set();
    const parts = String(raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const p of parts) {
      const m = p.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2}|\d{4})$/);
      if (!m) continue;

      const a = Number(m[1]); // dd or mm
      const b = Number(m[2]); // mm or dd
      const yRaw = m[3];
      const year = yRaw.length === 2 ? yearFrom2Digits(yRaw) : Number(yRaw);
      if (!year) continue;

      let iso = null;

      if (a > 12 && b <= 12) {
        iso = dmyToISO(a, b, year);
      } else if (b > 12 && a <= 12) {
        iso = mdyToISO(a, b, year);
      } else {
        iso = mdyToISO(a, b, year) || dmyToISO(a, b, year);
      }

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
  // Widget UI
  // -------------------------
  function createWidget({ mode }) {
    if (document.getElementById("agt-missing-standup-widget")) return;

    const root = document.createElement("div");
    root.id = "agt-missing-standup-widget";
    root.style.cssText = `
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 999999;
      width: 440px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Noto Sans", "Liberation Sans", sans-serif;
      color: #111827;
    `;

    root.innerHTML = `
      <div style="background: rgba(255,255,255,0.96);border: 1px solid rgba(0,0,0,0.12);border-radius: 12px;box-shadow: 0 10px 25px rgba(0,0,0,0.18);overflow: hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(0,0,0,0.08);gap:10px;">
          <div style="display:flex;align-items:center;gap:10px;min-width:0;">
            <div style="font-weight:900;font-size:13px;white-space:nowrap;">Standup Autofill</div>
            <div data-pill style="font-size:12px;background:rgba(17,24,39,0.06);padding:4px 8px;border-radius:999px;white-space:nowrap;"></div>
          </div>
          <button data-act="toggle" title="Minimize" style="border:none;background:transparent;cursor:pointer;font-size:14px;line-height:1;padding:4px 8px;border-radius:8px;">—</button>
        </div>

        <div data-body style="padding:10px 12px;display:block;max-height:78vh;overflow:auto;">
          <div data-employee-only style="display:none;">
            <div style="font-size:12px;color:rgba(17,24,39,0.7);margin-bottom:10px;">
              Detects <b>Missing Daily Standup</b> dates from Pending Tasks. Excluded dates will be skipped.
            </div>

            <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
              <button data-act="scan" style="padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#ffffff;color:#111827;cursor:pointer;font-weight:800;font-size:13px;">Scan Missing Dates</button>
              <button data-act="openFirst" style="flex:1;padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#111827;color:#fff;cursor:pointer;font-weight:900;font-size:13px;">Open Standup Form (Fill)</button>
            </div>

            <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;margin-bottom:10px;">
              Missing dates detected (editable list, comma/space/newline separated)
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
              Any Blockers / Questions (typing "No" selects No, anything else selects Yes)
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
              Exclude dates (comma separated). Formats: dd-mm-yy, mm-dd-yy, dd-mm-yyyy, mm-dd-yyyy (also accepts "/")
              <textarea data-field="excludeDates" rows="2" placeholder="e.g. 25-12-24, 12-31-2024"
                style="resize:vertical;padding:8px 10px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;font-size:12px;line-height:1.35;"></textarea>
            </label>

            <div style="display:flex;gap:8px;align-items:center;">
              <button data-act="save" style="flex:1;padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#ffffff;color:#111827;cursor:pointer;font-weight:900;font-size:13px;">Save Defaults</button>
              <button data-act="fillHere" style="padding:8px 10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:#111827;color:#fff;cursor:pointer;font-weight:900;font-size:13px;">Fill This Page</button>
            </div>

            <div data-status style="margin-top:2px;padding:8px 10px;border-radius:10px;background: rgba(17,24,39,0.06);font-size:12px;line-height:1.35;white-space: pre-wrap;min-height:66px;">Ready.</div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const bodyEl = root.querySelector("[data-body]");
    const pillEl = root.querySelector("[data-pill]");
    const statusEl = root.querySelector("[data-status]");
    const employeeOnly = root.querySelector("[data-employee-only]");

    const setStatus = (msg) => (statusEl.textContent = msg);
    const updatePill = (text) => (pillEl.textContent = text);

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
    };

    function buildPayloadFromFields() {
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
      };
    }

    function applyPayloadToFields(payload) {
      const def = getDefaultTexts();
      const p = payload || def;

      f.yesterday.value = p.yesterday ?? def.yesterday;
      f.achievements.value = p.achievements ?? def.achievements;
      f.today.value = p.today ?? def.today;
      f.tomorrow.value = p.tomorrow ?? def.tomorrow;

      f.assigned.value = String(p.assigned ?? def.assigned);
      f.tested.value = String(p.tested ?? def.tested);
      f.bugs.value = String(p.bugs ?? def.bugs);

      f.blockers.value = p.blockers ?? def.blockers;
      f.workStatus.value = p.workStatus ?? def.workStatus;

      f.excludeDates.value = p.excludeDates ?? def.excludeDates;
    }

    // init
    const state = loadState();
    applyPayloadToFields(state.payload || getDefaultTexts());

    if (mode === "employee") {
      employeeOnly.style.display = "block";

      const detected = extractMissingStandupDatesFromEmployeePage();
      const existingDates = parseISOListFromText(state.datesText || "");
      const merged = uniqSortedISO([...detected, ...existingDates]);

      f.dates.value = merged.join(", ");
      updatePill(`${merged.length} missing`);
      saveState({ ...state, datesText: f.dates.value });

      setStatus(
        `Detected missing dates: ${detected.length}\n` +
        `Stored/custom dates: ${existingDates.length}\n` +
        `Total list: ${merged.length}\n\n` +
        `Exclude dates will be applied when opening/filling the form.`
      );
    } else if (mode === "standup-form") {
      employeeOnly.style.display = "none";
      updatePill("standup-form");
      setStatus("Standup form mode. It will auto-fill (skipping excluded dates). It will NOT submit.");
    } else {
      updatePill(mode);
    }

    root.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const act = btn.getAttribute("data-act");

      if (act === "toggle") {
        const hidden = bodyEl.style.display === "none";
        bodyEl.style.display = hidden ? "block" : "none";
        btn.textContent = hidden ? "—" : "+";
        btn.title = hidden ? "Minimize" : "Expand";
        return;
      }

      if (act === "save") {
        const prev = loadState();
        saveState({
          ...prev,
          payload: buildPayloadFromFields(),
          datesText: prev.datesText ?? (f.dates?.value || ""),
        });
        setStatus("✅ Saved defaults (including exclude dates).");
        return;
      }

      if (act === "scan") {
        const detected = extractMissingStandupDatesFromEmployeePage();
        const manual = parseISOListFromText(f.dates.value);
        const merged = uniqSortedISO([...detected, ...manual]);

        f.dates.value = merged.join(", ");
        updatePill(`${merged.length} missing`);

        const prev = loadState();
        saveState({ ...prev, datesText: f.dates.value });

        setStatus(
          `✅ Scan complete.\nDetected: ${detected.length}\nMerged total: ${merged.length}\n\n` +
          (merged.length ? `Dates:\n${merged.join("\n")}` : "No missing dates found.")
        );
        return;
      }

      if (act === "openFirst") {
        const dates = parseISOListFromText(f.dates.value);
        if (!dates.length) {
          setStatus("❌ No dates found. Click Scan first, or paste ISO dates into the list.");
          return;
        }

        const payload = buildPayloadFromFields();
        const excludeSet = parseExcludeDatesToSet(payload.excludeDates);

        const filtered = dates.filter((d) => !excludeSet.has(d));
        updatePill(`${filtered.length} missing`);

        if (!filtered.length) {
          setStatus(`Nothing to open. All ${dates.length} dates are excluded by your Exclude Dates list.`);
          return;
        }

        saveState({
          payload,
          datesQueue: filtered,
          queueIndex: 0,
          lastOpenedAt: Date.now(),
          datesText: f.dates.value,
        });

        const first = filtered[0];
        setStatus(`Opening standup form for: ${first}\n(Will auto-fill, but NOT submit.)`);

        window.open(
          `https://allgentech.io/employee/standup-form?autoFillDate=${encodeURIComponent(first)}`,
          "_blank",
          "noopener,noreferrer"
        );
        return;
      }

      if (act === "fillHere") {
        if (location.pathname.replace(/\/+$/, "") !== "/employee/standup-form") {
          setStatus("This button is for the Standup Form page.\nUse “Open Standup Form (Fill)” from /employee.");
          return;
        }
        await fillStandupFormForCurrentDate(setStatus);
      }
    });

    if (f.dates) {
      f.dates.addEventListener("input", () => {
        const prev = loadState();
        saveState({ ...prev, datesText: f.dates.value });
        updatePill(`${parseISOListFromText(f.dates.value).length} missing`);
      });
    }

    const autosaveFields = ["yesterday","achievements","today","tomorrow","assigned","tested","bugs","blockers","workStatus","excludeDates"];
    for (const k of autosaveFields) {
      f[k].addEventListener("input", () => {
        const prev = loadState();
        saveState({ ...prev, payload: buildPayloadFromFields() });
      });
      f[k].addEventListener("change", () => {
        const prev = loadState();
        saveState({ ...prev, payload: buildPayloadFromFields() });
      });
    }

    return { setStatus, updatePill };
  }

  // -------------------------
  // Standup form filling
  // -------------------------
  function buildYesterdayWithAchievements(yesterday, achievements) {
    const y = String(yesterday || "").trim();
    const a = String(achievements || "").trim();
    if (!a) return y;
    return `${y}\n\nAchievements:\n${a}`;
  }

  function resolveTargetDateFromStateOrQuery(state) {
    const url = new URL(location.href);
    const qp = normalizeISODate(url.searchParams.get("autoFillDate"));
    if (qp) return qp;

    if (Array.isArray(state.datesQueue) && typeof state.queueIndex === "number") {
      const d = normalizeISODate(state.datesQueue[state.queueIndex]);
      if (d) return d;
    }
    return null;
  }

  async function fillStandupFormForCurrentDate(setStatus) {
    const state = loadState();
    const payload = state.payload || getDefaultTexts();

    const excludeSet = parseExcludeDatesToSet(payload.excludeDates);
    const dateToUse = resolveTargetDateFromStateOrQuery(state);

    if (!dateToUse) {
      setStatus("❌ No target date found.\nOpen this page via “Open Standup Form (Fill)” from /employee.");
      return;
    }

    if (excludeSet.has(dateToUse)) {
      setStatus(
        `⏭️ Skipped (excluded): ${dateToUse}\n` +
        `This date is in your Exclude Dates list.\n\nNo changes were made.`
      );
      return;
    }

    setStatus(`Filling form for: ${dateToUse}\n(Will NOT submit)\nWaiting for form...`);

    const form = await waitFor(() => document.querySelector("form"), 15000);
    if (!form) {
      setStatus("❌ Could not find the standup form.");
      return;
    }

    const dateInput = await waitFor(() =>
      form.querySelector('input[placeholder="YYYY-MM-DD"]') ||
      form.querySelector('input.input.input-bordered[type="text"]'),
      15000
    );
    if (!dateInput) {
      setStatus("❌ Could not find the Date input.");
      return;
    }
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
      await sleep(60);
    }

    setStatus(
      `✅ Filled for ${dateToUse}\n` +
      `Excluded dates count: ${excludeSet.size}\n` +
      `Work Status: ${wsWanted}\n` +
      `NOT submitted (as requested).`
    );
  }

  // -------------------------
  // Init by route
  // -------------------------
  async function init() {
    await ensureBody();

    const path = location.pathname.replace(/\/+$/, "");

    if (path === "/employee") {
      createWidget({ mode: "employee" });
      return;
    }

    if (path === "/employee/standup-form") {
      const { setStatus } = createWidget({ mode: "standup-form" });
      setTimeout(() => { fillStandupFormForCurrentDate(setStatus); }, 800);
      return;
    }

    createWidget({ mode: "employee*" });
  }

  init();
})();
