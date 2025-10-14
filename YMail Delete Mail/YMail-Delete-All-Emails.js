// (() => {
//   const s = 1000;
//   const CFG = {
//     RETRY_DELAY: 300,        // faster retry after actions
//     ENABLE_TIMEOUT: 3 * s,   // quicker enable check
//     LOOP_CAP: 9999
//   };
//   window.__stopDeleteLoop = false;

//   const SEL = {
//     selectAll: 'button[data-test-id="checkbox"][role="checkbox"]',
//     del:       'button[data-test-id="toolbar-delete"]',
//     anyCbs:    'button[data-test-id="checkbox"][role="checkbox"]'
//   };

//   const q = (s) => document.querySelector(s);
//   const qa = (s) => Array.from(document.querySelectorAll(s));
//   const cbSelectAll = () => q(SEL.selectAll);
//   const delBtn = () => q(SEL.del);

//   const rowCheckboxes = () =>
//     qa(SEL.anyCbs).filter(btn => !/Check all|Uncheck all/i.test(btn.getAttribute('title') || ''));

//   const sleep = (ms) => new Promise(r => setTimeout(r, ms));

//   const isChecked = (btn) => btn?.getAttribute('aria-checked') === 'true';
//   const isDisabled = (btn) => {
//     if (!btn) return true;
//     if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return true;
//     const cs = getComputedStyle(btn);
//     return cs.pointerEvents === 'none' || cs.visibility === 'hidden' || cs.opacity === '0';
//   };

//   const until = async (pred, timeout = 2 * s, step = 30) => {
//     const end = Date.now() + timeout;
//     while (Date.now() < end) {
//       try { if (pred()) return true; } catch {}
//       await sleep(step);
//     }
//     return false;
//   };

//   const strongClick = (el) => {
//     if (!el) return;
//     el.scrollIntoView({ block: 'center', inline: 'center' });
//     try { el.focus({ preventScroll: true }); } catch {}
//     ['pointerover','mouseover','pointerdown','mousedown','pointerup','mouseup','click']
//       .forEach(type => el.dispatchEvent(new MouseEvent(type, {
//         bubbles: true, cancelable: true, view: window, buttons: 1
//       })));
//   };

//   const trySelectAll = async () => {
//     const btn = cbSelectAll();
//     if (!btn) return false;
//     if (isChecked(btn)) return true;
//     strongClick(btn);
//     return await until(() => isChecked(cbSelectAll()), 1.5 * s);
//   };

//   const trySelectOneRow = async () => {
//     const rows = rowCheckboxes();
//     if (!rows.length) return false;
//     const target = rows.find(btn => !isChecked(btn)) || rows[0];
//     strongClick(target);
//     return await until(() => isChecked(target) || !isDisabled(delBtn()), 1.5 * s);
//   };

//   const ensureSelection = async () => {
//     if (await trySelectAll()) return true;
//     if (await trySelectOneRow()) return true;
//     return false;
//   };

//   (async function run() {
//     let i = 0;
//     console.log(`[delete-loop] start: delay=${CFG.RETRY_DELAY}ms, enableTimeout=${CFG.ENABLE_TIMEOUT / s}s`);
//     while (i++ < CFG.LOOP_CAP && !window.__stopDeleteLoop) {
//       const del = delBtn();
//       if (!del) { console.log('[delete-loop] delete button not found; stopping.'); break; }

//       const selected = await ensureSelection();
//       if (!selected) {
//         console.log('[delete-loop] could not select any messages; retrying …');
//         await sleep(CFG.RETRY_DELAY);
//         continue;
//       }

//       let enabled = await until(() => !isDisabled(delBtn()), CFG.ENABLE_TIMEOUT);
//       if (!enabled) {
//         const rows = rowCheckboxes();
//         if (rows.length) {
//           strongClick(rows[0]); await sleep(150);
//           strongClick(rows[0]); await sleep(150);
//           enabled = await until(() => !isDisabled(delBtn()), 2 * s);
//         }
//       }
//       if (!enabled) {
//         console.log('[delete-loop] delete stayed disabled; retrying …');
//         await sleep(CFG.RETRY_DELAY);
//         continue;
//       }

//       strongClick(delBtn());
//       console.log(`[delete-loop] clicked delete (iter ${i})`);

//       const confirmBtn =
//         q('button[aria-label="Delete"]') ||
//         q('button[data-test-id="ok"]') ||
//         q('button[data-action="confirm"]');
//       if (confirmBtn && !isDisabled(confirmBtn)) {
//         strongClick(confirmBtn);
//         await sleep(300);
//       }

//       await until(() =>
//         isDisabled(delBtn()) ||
//         !isChecked(cbSelectAll()) ||
//         rowCheckboxes().every(b => !isChecked(b)), 3 * s);

//       await sleep(150); // minimal pause before next loop
//     }
//     console.log('[delete-loop] finished. To stop early set: window.__stopDeleteLoop = true');
//   })();
// })();



(() => {
  // --- Keep the tab "active" so timers & UI don't stall in background ---
  const KeepAlive = (() => {
    let ac, gain, osc, audioEl, wl = null;
    async function startAudio() {
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        await ac.resume();
        gain = ac.createGain(); gain.gain.value = 0.00001; // essentially silent but "audible"
        osc = ac.createOscillator(); osc.frequency.value = 1;
        osc.connect(gain).connect(ac.destination); osc.start();
        console.log('[delete-loop] keepalive: WebAudio OK');
      } catch (e) {
        try {
          // 1s silent WAV
          const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
          audioEl = new Audio(SILENT_WAV);
          audioEl.loop = true;
          audioEl.volume = 0.01; // not muted (counts as playing)
          await audioEl.play();
          console.log('[delete-loop] keepalive: <audio> fallback OK');
        } catch (e2) {
          console.log('[delete-loop] keepalive: audio failed (autoplay policy?) — will keep trying.');
        }
      }
    }
    async function lockScreen() {
      try {
        if ('wakeLock' in navigator) {
          wl = await navigator.wakeLock.request('screen');
          wl.addEventListener('release', () => console.log('[delete-loop] wakeLock released'));
          document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState === 'visible') {
              try { wl = await navigator.wakeLock.request('screen'); } catch {}
            }
          });
          console.log('[delete-loop] keepalive: WakeLock OK');
        }
      } catch {}
    }
    function pinger() {
      setInterval(() => {
        try { navigator.sendBeacon?.('/favicon.ico', new Blob(['k'])); } catch {}
      }, 60_000);
    }
    function kick() {
      // try to (re)start audio periodically (handles autoplay blocks until a user gesture happens)
      startAudio();
      setInterval(startAudio, 20_000);
    }
    return { start: () => { kick(); lockScreen(); pinger(); } };
  })();

  // --- Your (enhanced) bulk delete loop ---
  const s = 1000;
  const CFG = {
    RETRY_DELAY: 300,
    ENABLE_TIMEOUT: 3 * s,
    LOOP_CAP: 9999
  };
  window.__stopDeleteLoop = false;

  const SEL = {
    selectAll: 'button[data-test-id="checkbox"][role="checkbox"]',
    del:       'button[data-test-id="toolbar-delete"]',
    anyCbs:    'button[data-test-id="checkbox"][role="checkbox"]'
  };

  const q  = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));

  const cbSelectAll = () => q(SEL.selectAll);
  const delBtn      = () => q(SEL.del);

  const rowCheckboxes = () =>
    qa(SEL.anyCbs).filter(btn => !/Check all|Uncheck all/i.test(btn.getAttribute('title') || ''));

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const isChecked = (btn) => btn?.getAttribute('aria-checked') === 'true';
  const isDisabled = (btn) => {
    if (!btn) return true;
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return true;
    const cs = getComputedStyle(btn);
    return cs.pointerEvents === 'none' || cs.visibility === 'hidden' || cs.opacity === '0';
  };

  const until = async (pred, timeout = 2 * s, step = 30) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (pred()) return true; } catch {}
      await sleep(step);
    }
    return false;
  };

  const strongClick = (el) => {
    if (!el) return;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    try { el.focus({ preventScroll: true }); } catch {}
    ['pointerover','mouseover','pointerdown','mousedown','pointerup','mouseup','click']
      .forEach(type => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, buttons: 1 })));
  };

  // Button finder by text (for generic “OK / Yes / Continue”)
  const findBtnByText = (...labels) => {
    const btns = qa('button, [role="button"]');
    const want = labels.map(x => x.toLowerCase());
    return btns.find(b => want.includes((b.textContent || '').trim().toLowerCase()));
  };

  const clearSelectAllOverlay = async () => {
    // “Select all conversations that match this search?” -> Yes/OK
    const ok = q('button[data-test-id="ok"]')
           || q('button[aria-label="OK"]')
           || findBtnByText('yes','ok','continue','apply');
    if (ok && !isDisabled(ok)) { strongClick(ok); await sleep(250); }
  };

  const trySelectAll = async () => {
    const btn = cbSelectAll();
    if (!btn) return false;
    if (!isChecked(btn)) {
      strongClick(btn);
      await sleep(120);
      await clearSelectAllOverlay(); // accept “select all matching search?”
    }
    return await until(() => isChecked(cbSelectAll()), 1.5 * s);
  };

  const trySelectOneRow = async () => {
    const rows = rowCheckboxes();
    if (!rows.length) return false;
    const target = rows.find(btn => !isChecked(btn)) || rows[0];
    strongClick(target);
    return await until(() => isChecked(target) || !isDisabled(delBtn()), 1.5 * s);
  };

  const ensureSelection = async () => {
    if (await trySelectAll()) return true;
    if (await trySelectOneRow()) return true;
    return false;
  };

  // Kick off keepalive and the loop
  KeepAlive.start();

  (async function run() {
    let i = 0;
    console.log(`[delete-loop] start: delay=${CFG.RETRY_DELAY}ms, enableTimeout=${CFG.ENABLE_TIMEOUT / s}s`);
    while (i++ < CFG.LOOP_CAP && !window.__stopDeleteLoop) {
      const del = delBtn();
      if (!del) { console.log('[delete-loop] delete button not found; stopping.'); break; }

      const selected = await ensureSelection();
      if (!selected) {
        console.log('[delete-loop] could not select any messages; retrying …');
        await sleep(CFG.RETRY_DELAY);
        continue;
      }

      // If Yahoo idles the toolbar in background, “nudge” a row to wake it
      let enabled = await until(() => !isDisabled(delBtn()), CFG.ENABLE_TIMEOUT);
      if (!enabled) {
        const rows = rowCheckboxes();
        if (rows.length) {
          strongClick(rows[0]); await sleep(120);
          strongClick(rows[0]); await sleep(120);
          enabled = await until(() => !isDisabled(delBtn()), 2 * s);
        }
      }
      if (!enabled) {
        console.log('[delete-loop] delete stayed disabled; retrying …');
        await sleep(CFG.RETRY_DELAY);
        continue;
      }

      strongClick(delBtn());
      console.log(`[delete-loop] clicked delete (iter ${i})`);

      // Confirm deletion modals (OK/Yes)
      const confirmBtn =
        q('button[aria-label="Delete"]') ||
        q('button[data-test-id="ok"]') ||
        q('button[data-action="confirm"]') ||
        findBtnByText('ok','yes','delete');
      if (confirmBtn && !isDisabled(confirmBtn)) {
        strongClick(confirmBtn);
        await sleep(300);
      }

      // Wait for state change (selection cleared or toolbar disabled)
      await until(() =>
        isDisabled(delBtn()) ||
        !isChecked(cbSelectAll()) ||
        rowCheckboxes().every(b => !isChecked(b)), 3 * s);

      await sleep(150);
    }
    console.log('[delete-loop] finished. To stop early set: window.__stopDeleteLoop = true');
  })();
})();
