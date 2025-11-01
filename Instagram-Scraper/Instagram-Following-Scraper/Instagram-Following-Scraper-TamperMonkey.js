// ==UserScript==
// @name         IG Following Scraper — PageContext Mini (5-min Probe)
// @namespace    https://auxo-qa.tools/
// @version      0.5
// @description  Collect usernames from the Instagram "Following" modal. Runs in PAGE context; includes long 5-minute micro-retry probe.
// @match        https://www.instagram.com/*
// @run-at       document-idle
// @inject-into  page
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* =========================
   * CONFIG (edit as needed)
   * ========================= */
  const CFG = {
    // Regular scrolling loop
    tickMs: 600,               // delay between normal scroll ticks
    bottomBackoffMs: 1100,     // extra wait at bottom before next tick
    scrollStepPx: 650,         // per tick scroll distance
    wigglePx: 240,             // small up/down to trigger lazy load

    // Growth detection & long probe
    noGrowthThreshold: 4,      // consecutive cycles with no new users before we enter long probe
    endProbeBudgetMs: 5 * 60 * 1000, // <-- up to 5 minutes of micro-checks
    endProbeIntervalMs: 300,   // small wait between each micro-check during probing

    // Safety & limits
    safetyTimeoutMs: 40 * 60 * 1000, // hard stop in case of runaway
    maxUsers: null,            // set a number to stop after collecting N users; null = unlimited

    // Output
    filename: 'ig_following.txt',
    dedupeCaseInsensitive: true,

    // Selectors
    dialogSel: 'div[role="dialog"]',
    scrollerSel: '',           // auto-detect if empty

    // Logging
    debug: true,
  };

  /* ==========
   * Utilities
   * ========== */
  const log = (...a) => CFG.debug && console.log('[IGX]', ...a);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const byCase = (s) => CFG.dedupeCaseInsensitive ? s.toLowerCase() : s;
  const fmt = (ms) => {
    ms = Math.max(0, ms|0);
    const m = String(Math.floor(ms / 60000)).padStart(1, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    return `${m}:${s}`;
  };

  function getDialog() {
    return document.querySelector(CFG.dialogSel);
  }

  function getScrollableRoot(dialog) {
    if (!dialog) return null;
    if (CFG.scrollerSel) {
      const el = dialog.querySelector(CFG.scrollerSel);
      if (el) return el;
    }
    const els = [dialog, ...dialog.querySelectorAll('div,section,main,article')];
    for (const el of els) {
      const cs = getComputedStyle(el);
      const scrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll');
      if (scrollable && el.scrollHeight > el.clientHeight + 8) return el;
    }
    return dialog;
  }

  function atBottom(scroller) {
    return Math.abs(scroller.scrollTop + scroller.clientHeight - scroller.scrollHeight) < 2;
  }

  function extractUsernameFromHref(href) {
    try {
      const u = new URL(href, location.origin);
      const parts = u.pathname.split('/').filter(Boolean);
      if (!parts.length) return null;
      const head = parts[0];
      if (['explore','reels','p','accounts','stories','challenge'].includes(head)) return null;
      if (parts.length !== 1) return null; // profile paths are one segment
      return head;
    } catch { return null; }
  }

  function downloadText(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ======
   * UI
   * ====== */
  const BTN_ID = 'igx-following-mini-btn';
  function ensureBtn() {
    let b = document.getElementById(BTN_ID);
    if (!b) {
      b = document.createElement('button');
      b.id = BTN_ID;
      b.textContent = 'IGX: Start (0)';
      Object.assign(b.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: 999999,
        font: '12px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
        background: '#111', color: '#fafafa', border: '1px solid #333',
        padding: '10px 12px', borderRadius: '12px', cursor: 'pointer',
        boxShadow: '0 6px 22px rgba(0,0,0,0.35)', opacity: '0.95'
      });
      b.addEventListener('click', () => RUNNING ? stopRun('Stopped by user') : startRun());
      document.body.appendChild(b);
    }
    return b;
  }
  const setBtn = (t) => { const b = ensureBtn(); b.textContent = t; };

  /* ==========
   * State
   * ========== */
  let RUNNING = false;
  let START_TS = 0;
  let CYCLES = 0;

  /* ================
   * Probe with budget
   * ================ */
  async function probeWithBudget(dialog, scroller, seen, startTotal) {
    const deadline = Date.now() + CFG.endProbeBudgetMs;
    let total = startTotal;
    let ticks = 0;

    while (RUNNING && Date.now() < deadline) {
      // keep the loader engaged
      if (atBottom(scroller)) {
        scroller.scrollBy({ top: -Math.min(CFG.wigglePx, scroller.scrollTop), behavior: 'auto' });
        await sleep(100);
      }
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
      await sleep(CFG.endProbeIntervalMs);

      const before = total;
      total += scan(dialog, seen);
      if (total > before) {
        log('Probe found more users:', total - before);
        return { total, foundMore: true };
      }

      // update button every ~5 ticks
      ticks++;
      if (ticks % 5 === 0) {
        setBtn(`Probing… ${fmt(deadline - Date.now())} • users ${total}`);
      }
    }
    return { total, foundMore: false };
  }

  /* ==================
   * Main Start/Stop
   * ================== */
  async function startRun() {
    const dialog = getDialog();
    if (!dialog) {
      setBtn('Open the “Following” modal first');
      setTimeout(() => setBtn('IGX: Start (0)'), 1800);
      return;
    }
    const scroller = getScrollableRoot(dialog);
    if (!scroller) {
      setBtn('No scrollable area found');
      setTimeout(() => setBtn('IGX: Start (0)'), 1800);
      return;
    }

    RUNNING = true;
    START_TS = Date.now();
    CYCLES = 0;

    const seen = new Set();
    let total = 0;
    let noGrowthCycles = 0;

    // initial scan
    total += scan(dialog, seen);
    setBtn(`Running… cycles ${CYCLES} • users ${total}`);
    log('Initial users:', total);

    try {
      while (RUNNING) {
        const before = total;
        total += scan(dialog, seen);
        if (total === before) noGrowthCycles++; else noGrowthCycles = 0;

        // stop conditions
        if (CFG.maxUsers && total >= CFG.maxUsers) {
          stopRun(`Hit maxUsers (${CFG.maxUsers})`);
          break;
        }
        if ((Date.now() - START_TS) > CFG.safetyTimeoutMs) {
          stopRun('Safety timeout');
          break;
        }

        // scrolling
        if (atBottom(scroller)) {
          scroller.scrollBy({ top: -CFG.wigglePx, behavior: 'auto' });
          scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
          await sleep(CFG.bottomBackoffMs);
        } else {
          scroller.scrollBy({ top: CFG.scrollStepPx, behavior: 'auto' });
          await sleep(CFG.tickMs);
        }

        CYCLES++;
        setBtn(`Running… cycles ${CYCLES} • users ${total}`);

        // Long probe when growth seems to stall
        if (noGrowthCycles >= CFG.noGrowthThreshold && atBottom(scroller)) {
          setBtn(`Probing… ${fmt(CFG.endProbeBudgetMs)} • users ${total}`);
          const { total: newTotal, foundMore } = await probeWithBudget(dialog, scroller, seen, total);
          total = newTotal;
          if (!foundMore) {
            stopRun('End of list (5-min probe)');
            break;
          } else {
            noGrowthCycles = 0; // resume normal loop
          }
        }
      }

      // finalize
      const users = [...seen].sort();
      const text = users.join('\n');
      setBtn(`Exporting… (${users.length})`);
      downloadText(CFG.filename, text);
      setBtn(`Done (${users.length}) — Click to Start`);
      log('Finished. Total:', users.length);

    } catch (e) {
      console.error('[IGX] Error in loop:', e);
      stopRun('Error (see console)');
    }
  }

  function stopRun(msg) {
    RUNNING = false;
    setBtn(`${msg} — Click to Start`);
  }

  function scan(dialog, seen) {
    let added = 0;
    const anchors = dialog.querySelectorAll('a[href^="/"]');
    for (const a of anchors) {
      const href = a.getAttribute('href');
      if (!href) continue;
      const u = extractUsernameFromHref(href);
      if (!u) continue;
      const key = byCase(u);
      if (!seen.has(key)) {
        seen.add(key);
        added++;
      }
    }
    return added;
  }

  /* =========
   * Bootstrap
   * ========= */
  ensureBtn();
  const mo = new MutationObserver(() => {
    if (!document.getElementById(BTN_ID)) ensureBtn();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

})();
