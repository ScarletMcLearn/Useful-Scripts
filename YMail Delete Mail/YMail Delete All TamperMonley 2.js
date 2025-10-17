// ==UserScript==
// @name         Y! Mail — Bulk Delete (Select-All + Keep-Alive + Buttons + Hotkey)
// @namespace    tm-yahoo-mail-bulk-delete
// @version      2.7.0
// @description  One-click Start/Stop bulk delete in Yahoo Mail. Auto Select-All, auto confirm, robust keep-alive (audio + worker + beacons + scroll nudge + optional wake lock). Toolbar button, floating button, and hotkey (Ctrl+Alt+D). Shows run/deleted counters. Manual start only.
// @author       you
// @match        https://mail.yahoo.com/*
// @match        https://*.mail.yahoo.com/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const s = 1000;
  const CFG = {
    RETRY_DELAY: 320,
    ENABLE_TIMEOUT: 3 * s,
    LOOP_CAP: 999999,

    // Count logic
    EMAILS_PER_ITER: 25, // each successful delete pass ≈ 25 emails

    // Keep-alive knobs
    USE_AUDIO: true,           // quiet WebAudio oscillator (unmuted)
    USE_WORKER_TICK: true,     // background worker heartbeat
    USE_BEACON: true,          // sendBeacon ping
    USE_SCROLL_NUDGE: true,    // 1px scroll toggle to trigger events
    USE_WAKE_LOCK: true,       // optional Screen Wake Lock (when visible)
    KEEPALIVE_PING_MS: 60_000,
    WORKER_TICK_MS: 10_000,

    LOG_DEBUG: true            // extra console logs
  };

  const LOG = {
    d: (...a) => CFG.LOG_DEBUG && console.log('[ymbd]', ...a),
    i: (...a) => console.log('[ymbd]', ...a),
    w: (...a) => console.warn('[ymbd]', ...a),
    e: (...a) => console.error('[ymbd]', ...a),
  };

  let running = false;
  let runs = 0;               // successful delete executions (× EMAILS_PER_ITER ≈ emails)
  let worker = null;
  let wakeLock = null;
  let audioCtx = null, gain = null, osc = null, audioTag = null;

  unsafeWindow.__ymbd_stop = false;

  // ---------- UI ----------
  GM_addStyle(`
    #ymbd-panel {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      background: rgba(18,18,18,.92); color: #fff; font: 12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      padding: 10px 12px; border-radius: 999px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      box-shadow: 0 8px 24px rgba(0,0,0,.35); pointer-events: auto;
    }
    #ymbd-panel button, .ymbd-toolbar-btn {
      appearance: none; border: 0; border-radius: 999px; padding: 6px 10px; cursor: pointer;
      background: #22c55e; color: #0b1f0f; font-weight: 700;
    }
    #ymbd-panel button[aria-pressed="true"], .ymbd-toolbar-btn[aria-pressed="true"] { background: #ef4444; color: #2a0c0c; }
    #ymbd-panel .muted { opacity: .8 }
    .ymbd-toolbar-btn { margin-left: 8px; font-size: 12px !important; line-height: 1 !important; }
    #ymbd-stats { display: inline-flex; gap: 8px; align-items: center; }
    #ymbd-stats .kv { background: rgba(255,255,255,.08); padding: 3px 6px; border-radius: 6px; }
    #ymbd-stats .k { opacity: .7; margin-right: 4px; }
  `);

  function buildFloatingUI() {
    if (document.getElementById('ymbd-panel')) return;
    const el = document.createElement('div');
    el.id = 'ymbd-panel';
    el.innerHTML = `
      <span id="ymbd-status" class="muted">Stopped</span>
      <span id="ymbd-stats">
        <span class="kv"><span class="k">Runs:</span><span id="ymbd-runs">0</span></span>
        <span class="kv"><span class="k">Deleted (est.):</span><span id="ymbd-deleted">0</span></span>
      </span>
      <button id="ymbd-toggle" type="button" aria-pressed="false" title="Start/Stop bulk delete">Start</button>
    `;
    document.body.appendChild(el);
    document.getElementById('ymbd-toggle').addEventListener('click', toggle);
  }

  function buildToolbarBtn() {
    const toolbar = document.querySelector('[data-test-id="toolbar"]') ||
                    document.querySelector('[role="toolbar"]');
    if (!toolbar || toolbar.querySelector('.ymbd-toolbar-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'ymbd-toolbar-btn';
    btn.type = 'button';
    btn.textContent = running ? 'Stop' : 'Start';
    btn.title = 'Start/Stop bulk delete';
    btn.setAttribute('aria-pressed', running ? 'true' : 'false');
    btn.addEventListener('click', toggle);
    toolbar.appendChild(btn); 
  }

  function setUI(runningNow) {
    const st = document.getElementById('ymbd-status');
    const btn = document.getElementById('ymbd-toggle');
    if (st) st.textContent = runningNow ? 'Running…' : 'Stopped';
    if (btn) {
      btn.textContent = runningNow ? 'Stop' : 'Start';
      btn.setAttribute('aria-pressed', runningNow ? 'true' : 'false');
    }
    const tbtn = document.querySelector('.ymbd-toolbar-btn');
    if (tbtn) {
      tbtn.textContent = runningNow ? 'Stop' : 'Start';
      tbtn.setAttribute('aria-pressed', runningNow ? 'true' : 'false');
    }
  }

  function setCounts() {
    const r = document.getElementById('ymbd-runs');
    const d = document.getElementById('ymbd-deleted');
    if (r) r.textContent = String(runs);
    if (d) d.textContent = String(runs * CFG.EMAILS_PER_ITER);
  }

  // ---------- DOM utils ----------
  const q  = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const until = async (pred, timeout = 2000, step = 40) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (pred()) return true; } catch {}
      await sleep(step);
    }
    return false;
  };

  // robust click — uses the element’s own window (fixes the MouseEvent 'view' error)
  const strongClick = (el) => {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    try { el.focus({ preventScroll: true }); } catch {}
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const types = ['pointerover','mouseover','pointerdown','mousedown','pointerup','mouseup','click'];
    for (const type of types) {
      try {
        const Ctor = (type.startsWith('pointer') && view.PointerEvent) ? view.PointerEvent : view.MouseEvent;
        el.dispatchEvent(new Ctor(type, {
          bubbles: true, cancelable: true, composed: true,
          view, buttons: 1, pointerId: 1, pointerType: 'mouse'
        }));
      } catch {
        if (type === 'click') try { el.click(); } catch {}
      }
    }
    return true;
  };

  const isChecked = (btn) => btn?.getAttribute('aria-checked') === 'true';
  const isDisabled = (btn) => {
    if (!btn) return true;
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return true;
    const cs = getComputedStyle(btn);
    return cs.pointerEvents === 'none' || cs.visibility === 'hidden' || cs.opacity === '0';
  };

  const SEL = {
    selectAll: [
      'button[role="checkbox"][title*="Select"]',
      'button[role="checkbox"][title*="Check all"]',
      'button[role="checkbox"][aria-label*="Select"]',
      'button[role="checkbox"][aria-label*="Check all"]',
      'button[data-test-id="checkbox"][role="checkbox"]'
    ].join(','),

    del: [
      'button[data-test-id="toolbar-delete"]',
      'button[aria-label="Delete"]',
      'button[title="Delete"]',
      'button[aria-label*="Delete"]',
      'button[data-test-id*="delete"]'
    ].join(','),

    anyCbs: [
      'button[role="checkbox"]',
      '[role="row"] button[role="checkbox"]',
      '[data-test-id="message-row"] button[role="checkbox"]'
    ].join(','),

    confirm: [
      'button[aria-label="Delete"]',
      'button[data-test-id="ok"]',
      'button[data-action="confirm"]',
      'button[data-test-id="primaryBtn"]'
    ].join(','),

    toolbar: '[data-test-id="toolbar"], [role="toolbar"]',
    listAnyRow: '[data-test-id="message-row"], [role="row"], li[draggable="true"]'
  };

  const cbSelectAll  = () => q(SEL.selectAll);
  const delBtn       = () => q(SEL.del);
  const anyRowsExist = () => !!q(SEL.listAnyRow);
  const rowCheckboxes = () =>
    qa(SEL.anyCbs).filter(btn => !/Check all|Uncheck all|Select all/i.test(
      (btn.getAttribute('title') || btn.getAttribute('aria-label') || '')
    ));

  const findBtnByText = (...labels) => {
    const btns = qa('button,[role="button"]');
    const want = labels.map(x => x.toLowerCase());
    return btns.find(b => want.includes((b.textContent || '').trim().toLowerCase()));
  };

  // ---------- Keep-alive helpers ----------
  async function startAudio() {
    if (!CFG.USE_AUDIO) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume();
      if (!osc) {
        gain = audioCtx.createGain(); gain.gain.value = 0.001; // not muted
        osc = audioCtx.createOscillator(); osc.frequency.value = 1; // 1 Hz
        osc.connect(gain).connect(audioCtx.destination);
        osc.start();
        LOG.d('audio keep-alive started');
      }
    } catch {
      // fallback <audio> with a silent WAV (still non-muted)
      const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
      try {
        if (!audioTag) { audioTag = new Audio(SILENT_WAV); audioTag.loop = true; audioTag.volume = 0.01; }
        await audioTag.play();
        LOG.d('audio tag keep-alive started');
      } catch {}
    }
  }
  function stopAudio() {
    try { osc?.stop(); } catch {}
    try { audioCtx?.close(); } catch {}
    try { audioTag?.pause(); } catch {}
    osc = gain = audioCtx = audioTag = null;
  }

  function workerStart() {
    if (!CFG.USE_WORKER_TICK) return;
    try { worker?.terminate(); } catch {}
    const src = `setInterval(()=>postMessage(Date.now()), ${CFG.WORKER_TICK_MS});`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript'})));
    worker.onmessage = () => {
      try {
        document.body?.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:1, clientY:1}));
        window.dispatchEvent(new Event('scroll', {bubbles:true}));
        if (CFG.USE_SCROLL_NUDGE) nudgeScroll();
      } catch {}
    };
  }
  function workerStop() { try { worker?.terminate(); } catch {} worker = null; }

  function pingerStart() {
    if (!CFG.USE_BEACON) return;
    setInterval(() => { try { navigator.sendBeacon?.('/favicon.ico', new Blob(['k'])); } catch {} }, CFG.KEEPALIVE_PING_MS);
  }

  function nudgeScroll() {
    try {
      const el = document.scrollingElement || document.documentElement;
      const y = el.scrollTop;
      el.scrollTop = y + 1;
      el.scrollTop = y;
    } catch {}
  }

  async function acquireWakeLock() {
    if (!CFG.USE_WAKE_LOCK || !('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => LOG.d('wake lock released'));
      LOG.d('wake lock acquired');
    } catch (e) {
      // ignored (not supported or denied)
    }
  }
  function releaseWakeLock() {
    try { wakeLock?.release(); } catch {}
    wakeLock = null;
  }

  function startKeepAlive() {
    startAudio();         // requires user gesture – OK (we call from Start button)
    workerStart();
    pingerStart();
    if (!document.hidden) acquireWakeLock();
  }
  function stopKeepAlive() {
    workerStop();
    stopAudio();
    releaseWakeLock();
  }

  document.addEventListener('visibilitychange', () => {
    if (!running) return;
    if (document.hidden) {
      // wake lock releases automatically; audio/worker continue
    } else {
      // re-acquire on return to tab
      acquireWakeLock();
      startAudio();
    }
  });

  // ---------- Actions ----------
  const clearSelectAllOverlay = async () => {
    const btn =
      q('button[data-test-id="ok"]') ||
      q('button[aria-label="OK"]') ||
      q('button[data-action="confirm"]') ||
      findBtnByText('yes','ok','continue','apply','select all');
    if (btn && !isDisabled(btn)) { strongClick(btn); await sleep(200); }
  };

  const trySelectAll = async () => {
    const b = cbSelectAll();
    if (!b) { LOG.d('no select-all found'); return false; }
    if (!isChecked(b)) {
      LOG.d('click select-all');
      strongClick(b);
      await sleep(120);
      await clearSelectAllOverlay();
    }
    const ok = await until(() => isChecked(cbSelectAll()), 1500);
    if (!ok) LOG.d('select-all not checked yet');
    return ok;
  };

  const trySelectOneRow = async () => {
    const rows = rowCheckboxes();
    if (!rows.length) { LOG.d('no row checkboxes'); return false; }
    const target = rows.find(btn => !isChecked(btn)) || rows[0];
    LOG.d('wake toolbar via first row checkbox');
    strongClick(target);
    return await until(() => isChecked(target) || !isDisabled(delBtn()), 1500);
  };

  const ensureSelection = async () => (await trySelectAll()) || (await trySelectOneRow());

  const tryConfirmDelete = async () => {
    const btn =
      q(SEL.confirm) ||
      findBtnByText('ok','yes','delete','permanently delete');
    if (btn && !isDisabled(btn)) {
      LOG.d('confirming delete');
      strongClick(btn);
      await sleep(250);
    }
  };

  const wakeToolbar = async () => {
    const rows = rowCheckboxes();
    if (rows.length) {
      strongClick(rows[0]); await sleep(100);
      strongClick(rows[0]); await sleep(100);
    } else {
      const list = q('[role="grid"], [role="listbox"], main');
      if (list) { strongClick(list); await sleep(100); }
    }
  };

  // ---------- Main loop ----------
  async function runLoop() {
    running = true;
    runs = 0;                 // reset per manual start
    setUI(true);
    setCounts();
    startKeepAlive();
    LOG.i('start loop');

    let loops = 0;
    while (running && loops++ < CFG.LOOP_CAP && !unsafeWindow.__ymbd_stop) {
      const del = delBtn();
      if (!del) {
        LOG.w('delete button not found; waiting for toolbar…');
        await until(() => !!delBtn(), 3000);
        if (!delBtn()) { await sleep(CFG.RETRY_DELAY); continue; }
      }

      if (!anyRowsExist()) {
        LOG.d('no rows visible; waiting…');
        await sleep(CFG.RETRY_DELAY);
        continue;
      }

      const selected = await ensureSelection();
      if (!selected) {
        LOG.d('selection failed; retrying…');
        await sleep(CFG.RETRY_DELAY);
        continue;
      }

      let enabled = await until(() => !isDisabled(delBtn()), CFG.ENABLE_TIMEOUT);
      if (!enabled) {
        LOG.d('delete disabled; waking toolbar…');
        await wakeToolbar();
        enabled = await until(() => !isDisabled(delBtn()), 2 * s);
      }
      if (!enabled) {
        LOG.d('still disabled; retry…');
        await sleep(CFG.RETRY_DELAY);
        continue;
      }

      LOG.d('click delete');
      strongClick(delBtn());
      await tryConfirmDelete();

      // wait for UI to reflect deletion
      await until(() =>
        isDisabled(delBtn()) ||
        !isChecked(cbSelectAll()) ||
        rowCheckboxes().every(b => !isChecked(b)),
        3 * s
      );

      // ✅ count this run after a completed delete
      runs += 1;
      setCounts();

      await sleep(140);
    }

    stop();
  }

  function start() {
    unsafeWindow.__ymbd_stop = false;
    if (!running) runLoop();
  }
  function stop() {
    running = false;
    unsafeWindow.__ymbd_stop = true;
    stopKeepAlive();
    setUI(false);
    LOG.i('stopped');
  }
  function toggle() { running ? stop() : start(); }

  // ---------- Bootstrapping ----------
  function onReady() {
    if (document.body) buildFloatingUI(); else
      document.addEventListener('DOMContentLoaded', buildFloatingUI, { once: true });
    buildToolbarBtn();
  }

  const mo = new MutationObserver(() => {
    if (!document.getElementById('ymbd-panel') && document.body) buildFloatingUI();
    buildToolbarBtn();
  });
  const observe = () => mo.observe(document.documentElement, { childList: true, subtree: true });

  function registerMenu() {
    GM_registerMenuCommand('Start deleting', start);
    GM_registerMenuCommand('Stop deleting', stop);
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.code === 'KeyD') { e.preventDefault(); toggle(); }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady, { once: true });
  } else {
    onReady();
  }
  observe();
  registerMenu();

  // 🚫 No auto-start — manual only.

})();
