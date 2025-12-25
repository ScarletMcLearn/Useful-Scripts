// ==UserScript==
// @name         GitHub Profile Auto Reloader (ScarletMcLearn) — Keep Alive
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  Start/Stop auto-reload on your GitHub profile with counter + robust keep-alive (audio + worker + beacon + scroll nudge + optional wake lock) to reduce Edge tab throttling.
// @author       You
// @match        https://github.com/ScarletMcLearn*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  const s = 1000;

  const CFG = {
    // Reload interval (random)
    MIN_SECONDS: 5,
    MAX_SECONDS: 10,

    // Keep-alive knobs (like your Yahoo script)
    USE_AUDIO: true,           // WebAudio oscillator or <audio> fallback
    USE_WORKER_TICK: true,     // background worker heartbeat
    USE_BEACON: true,          // sendBeacon ping
    USE_SCROLL_NUDGE: true,    // 1px scroll toggle
    USE_WAKE_LOCK: true,       // screen wake lock (visible tabs only, if supported)

    KEEPALIVE_PING_MS: 60_000,
    WORKER_TICK_MS: 10_000,

    // Reload drift guard (helps when timers get throttled)
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

  // ---------- Styles ----------
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

  // ---------- Storage ----------
  function getActive() { return GM_getValue(STORAGE_ACTIVE_KEY, false); }
  function setActive(val) { GM_setValue(STORAGE_ACTIVE_KEY, !!val); }

  function getCounter() { return GM_getValue(STORAGE_COUNTER_KEY, 0); }
  function setCounter(val) { GM_setValue(STORAGE_COUNTER_KEY, Number(val) || 0); }

  function getNextAt() { return GM_getValue(STORAGE_NEXT_AT_KEY, 0); }
  function setNextAt(val) { GM_setValue(STORAGE_NEXT_AT_KEY, Number(val) || 0); }

  // ---------- Keep-alive helpers ----------
  async function startAudio() {
    if (!CFG.USE_AUDIO) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume();

      if (!osc) {
        gain = audioCtx.createGain();
        gain.gain.value = 0.001; // not muted, but extremely quiet
        osc = audioCtx.createOscillator();
        osc.frequency.value = 1; // 1Hz
        osc.connect(gain).connect(audioCtx.destination);
        osc.start();
        LOG.d('audio keep-alive started (webaudio)');
      }
    } catch (e) {
      // fallback: silent wav in <audio> (still non-muted)
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
        LOG.w('audio keep-alive failed (blocked by browser?)');
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
        // gentle activity pulses
        try {
          document.body?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 }));
          window.dispatchEvent(new Event('scroll', { bubbles: true }));
          nudgeScroll();
          // also drift-check reload timing when we get a tick
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
    // fire and forget; not trying to keep tab alive by itself, just adds activity
    setInterval(() => {
      try {
        navigator.sendBeacon?.('/favicon.ico', new Blob(['k']));
      } catch {}
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
      // ignore (not supported/denied)
      LOG.d('wake lock not available/denied');
    }
  }

  function releaseWakeLock() {
    try { wakeLock?.release(); } catch {}
    wakeLock = null;
  }

  function startKeepAlive() {
    // Start ONLY when user clicks Start (gesture) or when active reload brings you back
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
      // re-acquire on tab return
      acquireWakeLock();
      startAudio();
      // and run a drift-check immediately
      maybeReloadIfOverdue();
    }
  });

  // ---------- Reload scheduling ----------
  function computeDelayMs() {
    const min = CFG.MIN_SECONDS;
    const max = CFG.MAX_SECONDS;
    const delaySeconds = min + Math.random() * (max - min);
    return Math.round(delaySeconds * 1000);
  }

  function safeReload() {
    // If you ever want to “soft refresh” a section instead, this is where you’d change behavior.
    window.location.reload();
  }

  function maybeReloadIfOverdue() {
    if (!getActive()) return;
    const nextAt = getNextAt();
    if (!nextAt) return;

    // If throttling delayed timers, force reload once we're overdue
    if (Date.now() >= nextAt) {
      LOG.d('overdue -> forcing reload now');
      safeReload();
    }
  }

  function scheduleReload() {
    const delayMs = computeDelayMs();
    const nextAt = Date.now() + delayMs;
    setNextAt(nextAt);

    clearTimeout(reloadTimerId);
    reloadTimerId = setTimeout(() => {
      safeReload();
    }, delayMs);

    // Drift guard (helps when background throttling pauses setTimeout)
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

    // set counter to 1 on manual start
    setCounter(1);
    updateButtonLabel(btn);

    startKeepAlive();   // user gesture happens here
    scheduleReload();

    LOG.i('started');
  }

  function onButtonClick() {
    const btn = document.getElementById('smc-auto-reload-btn');
    if (!btn) return;

    const active = getActive();
    if (!active) startAll(btn);
    else {
      stopAll();
      updateButtonLabel(btn);
    }
  }

  function createButton() {
    let btn = document.getElementById('smc-auto-reload-btn');
    if (btn) return btn;

    btn = document.createElement('button');
    btn.id = 'smc-auto-reload-btn';
    btn.textContent = 'Start';
    btn.addEventListener('click', onButtonClick);

    document.addEventListener('DOMContentLoaded', () => {
      document.body.appendChild(btn);
    }, { once: true });

    // If body already exists
    if (document.body) document.body.appendChild(btn);

    return btn;
  }

  // ---------- Init ----------
  function init() {
    const btn = createButton();

    if (getActive()) {
      // We arrived due to an active auto-reload cycle
      const current = getCounter();
      setCounter((current > 0 ? current : 0) + 1);

      updateButtonLabel(btn);

      // Keep-alive should re-start on load
      startKeepAlive();
      scheduleReload();
      LOG.d('resumed active session');
    } else {
      updateButtonLabel(btn);
      stopKeepAlive();
    }
  }

  // Menu shortcuts
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
