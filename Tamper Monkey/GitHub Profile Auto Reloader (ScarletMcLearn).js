// ==UserScript==
// @name         GitHub Profile Auto Reloader (ScarletMcLearn) — Keep Alive (Profile Only)
// @namespace    http://tampermonkey.net/
// @version      2.0.1
// @description  Start/Stop auto-reload ONLY on https://github.com/ScarletMcLearn (no other GitHub pages), with counter + keep-alive (audio + worker + beacon + scroll nudge + optional wake lock).
// @author       You
// @match        https://github.com/ScarletMcLearn
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  // ✅ HARD GUARD: do nothing unless we are EXACTLY on the page you gave
  // (If you want to allow ?tab=repositories etc., remove the search/hash checks.)
  const TARGET_PATHS = new Set(['/ScarletMcLearn', '/ScarletMcLearn/']);
  const onExactProfilePage =
    location.hostname === 'github.com' &&
    TARGET_PATHS.has(location.pathname) &&
    location.search === '' &&
    location.hash === '';

  if (!onExactProfilePage) return;

  const s = 1000;

  const CFG = {
    MIN_SECONDS: 5,
    MAX_SECONDS: 10,

    USE_AUDIO: true,
    USE_WORKER_TICK: true,
    USE_BEACON: true,
    USE_SCROLL_NUDGE: true,
    USE_WAKE_LOCK: true,

    KEEPALIVE_PING_MS: 60_000,
    WORKER_TICK_MS: 10_000,

    DRIFT_CHECK_MS: 1500,
    LOG_DEBUG: true
  };

  const LOG = {
    d: (...a) => CFG.LOG_DEBUG && console.log('[smc-reload]', ...a),
    i: (...a) => console.log('[smc-reload]', ...a),
    w: (...a) => console.warn('[smc-reload]', ...a),
    e: (...a) => console.error('[smc-reload]', ...a),
  };

  const STORAGE_ACTIVE_KEY  = 'smc_autoReloadActive';
  const STORAGE_COUNTER_KEY = 'smc_autoReloadCounter';
  const STORAGE_NEXT_AT_KEY  = 'smc_autoReloadNextAt';

  let reloadTimerId = null;
  let driftTimerId = null;

  // Keep-alive state
  let worker = null;
  let wakeLock = null;
  let audioCtx = null, gain = null, osc = null, audioTag = null;

  GM_addStyle(`
    #smc-auto-reload-btn {
      position: fixed;
      right: 20px;
      bottom: 20px;
      padding: 10px 16px;
      color: #ffffff;
      border: none;
      border-radius: 10px;
      font-size: 14px;
      cursor: pointer;
      z-index: 2147483647;
      box-shadow: 0 2px 10px rgba(0,0,0,.25);
    }
    #smc-auto-reload-btn:hover { opacity: .92; }
  `);

  function getActive() { return GM_getValue(STORAGE_ACTIVE_KEY, false); }
  function setActive(val) { GM_setValue(STORAGE_ACTIVE_KEY, !!val); }

  function getCounter() { return GM_getValue(STORAGE_COUNTER_KEY, 0); }
  function setCounter(val) { GM_setValue(STORAGE_COUNTER_KEY, Number(val) || 0); }

  function getNextAt() { return GM_getValue(STORAGE_NEXT_AT_KEY, 0); }
  function setNextAt(val) { GM_setValue(STORAGE_NEXT_AT_KEY, Number(val) || 0); }

  // ---------- Keep-alive ----------
  async function startAudio() {
    if (!CFG.USE_AUDIO) return;
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
        LOG.d('audio keep-alive started (webaudio)');
      }
    } catch {
      const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
      try {
        if (!audioTag) {
          audioTag = new Audio(SILENT_WAV);
          audioTag.loop = true;
          audioTag.volume = 0.01;
        }
        await audioTag.play();
        LOG.d('audio keep-alive started (audio tag)');
      } catch {
        LOG.w('audio keep-alive failed (blocked?)');
      }
    }
  }

  function stopAudio() {
    try { osc?.stop(); } catch {}
    try { audioCtx?.close(); } catch {}
    try { audioTag?.pause(); } catch {}
    osc = gain = audioCtx = audioTag = null;
  }

  function nudgeScroll() {
    if (!CFG.USE_SCROLL_NUDGE) return;
    try {
      const el = document.scrollingElement || document.documentElement;
      const y = el.scrollTop;
      el.scrollTop = y + 1;
      el.scrollTop = y;
    } catch {}
  }

  function workerStart() {
    if (!CFG.USE_WORKER_TICK) return;
    workerStop();
    try {
      const src = `setInterval(()=>postMessage(Date.now()), ${CFG.WORKER_TICK_MS});`;
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = () => {
        try {
          document.body?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 }));
          window.dispatchEvent(new Event('scroll', { bubbles: true }));
          nudgeScroll();
          maybeReloadIfOverdue();
        } catch {}
      };
      LOG.d('worker keep-alive started');
    } catch {
      LOG.w('worker keep-alive failed');
    }
  }

  function workerStop() {
    try { worker?.terminate(); } catch {}
    worker = null;
  }

  function pingerStart() {
    if (!CFG.USE_BEACON) return;
    setInterval(() => {
      try { navigator.sendBeacon?.('/favicon.ico', new Blob(['k'])); } catch {}
    }, CFG.KEEPALIVE_PING_MS);
    LOG.d('beacon pinger scheduled');
  }

  async function acquireWakeLock() {
    if (!CFG.USE_WAKE_LOCK) return;
    if (!('wakeLock' in navigator)) return;
    if (document.hidden) return;

    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => LOG.d('wake lock released'));
      LOG.d('wake lock acquired');
    } catch {
      LOG.d('wake lock not available/denied');
    }
  }

  function releaseWakeLock() {
    try { wakeLock?.release(); } catch {}
    wakeLock = null;
  }

  function startKeepAlive() {
    startAudio();
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
    if (!getActive()) return;
    if (!document.hidden) {
      acquireWakeLock();
      startAudio();
      maybeReloadIfOverdue();
    }
  });

  // ---------- Reload scheduling ----------
  function computeDelayMs() {
    const delaySeconds = CFG.MIN_SECONDS + Math.random() * (CFG.MAX_SECONDS - CFG.MIN_SECONDS);
    return Math.round(delaySeconds * 1000);
  }

  function safeReload() { window.location.reload(); }

  function maybeReloadIfOverdue() {
    if (!getActive()) return;
    const nextAt = getNextAt();
    if (nextAt && Date.now() >= nextAt) {
      LOG.d('overdue -> forcing reload now');
      safeReload();
    }
  }

  function scheduleReload() {
    const delayMs = computeDelayMs();
    const nextAt = Date.now() + delayMs;
    setNextAt(nextAt);

    clearTimeout(reloadTimerId);
    reloadTimerId = setTimeout(safeReload, delayMs);

    clearInterval(driftTimerId);
    driftTimerId = setInterval(maybeReloadIfOverdue, CFG.DRIFT_CHECK_MS);

    LOG.d('scheduled reload in ms:', delayMs);
  }

  // ---------- UI ----------
  function updateButtonLabel(btn) {
    const active = getActive();
    const counter = getCounter();
    if (active) {
      btn.textContent = `Stop | Counter = ${counter}`;
      btn.style.backgroundColor = '#c93c3c';
    } else {
      btn.textContent = 'Start';
      btn.style.backgroundColor = '#238636';
    }
  }

  function stopAll() {
    setActive(false);
    clearTimeout(reloadTimerId);
    clearInterval(driftTimerId);
    reloadTimerId = null;
    driftTimerId = null;
    setNextAt(0);
    stopKeepAlive();
    LOG.i('stopped');
  }

  function startAll(btn) {
    setActive(true);
    setCounter(1);
    updateButtonLabel(btn);
    startKeepAlive();     // user gesture is the Start click
    scheduleReload();
    LOG.i('started');
  }

  function onButtonClick() {
    const btn = document.getElementById('smc-auto-reload-btn');
    if (!btn) return;
    if (!getActive()) startAll(btn);
    else { stopAll(); updateButtonLabel(btn); }
  }

  function createButton() {
    let btn = document.getElementById('smc-auto-reload-btn');
    if (btn) return btn;

    btn = document.createElement('button');
    btn.id = 'smc-auto-reload-btn';
    btn.textContent = 'Start';
    btn.addEventListener('click', onButtonClick);

    if (document.body) document.body.appendChild(btn);
    else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(btn), { once: true });

    return btn;
  }

  function init() {
    const btn = createButton();

    if (getActive()) {
      const current = getCounter();
      setCounter((current > 0 ? current : 0) + 1);
      updateButtonLabel(btn);
      startKeepAlive();
      scheduleReload();
      LOG.d('resumed active session');
    } else {
      updateButtonLabel(btn);
      stopKeepAlive();
    }
  }

  GM_registerMenuCommand('Start auto-reload', () => {
    const btn = createButton();
    if (!getActive()) startAll(btn);
    else updateButtonLabel(btn);
  });

  GM_registerMenuCommand('Stop auto-reload', () => {
    stopAll();
    const btn = document.getElementById('smc-auto-reload-btn');
    if (btn) updateButtonLabel(btn);
  });

  // Hotkey: Ctrl+Alt+R
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.code === 'KeyR') {
      e.preventDefault();
      const btn = createButton();
      if (!getActive()) startAll(btn);
      else { stopAll(); updateButtonLabel(btn); }
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
