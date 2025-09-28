(() => {
  // ===== time units & config (2 * s = 2 seconds) =====
  const s = 1000;
  const CFG = {
    RETRY_DELAY: 1 * s,      // wait after actions
    ENABLE_TIMEOUT: 6 * s,   // wait for Delete to enable
    LOOP_CAP: 9999
  };
  // Set to true in console to stop any time:
  window.__stopDeleteLoop = false;

  // ===== selectors (from your DOM) =====
  const SEL = {
    // Toolbar select-all checkbox
    selectAll: 'button[data-test-id="checkbox"][role="checkbox"]',
    // Delete button in toolbar
    del:       'button[data-test-id="toolbar-delete"]',
    // Any checkbox buttons; we’ll filter out the select-all by title text
    anyCbs:    'button[data-test-id="checkbox"][role="checkbox"]'
  };

  // ===== helpers (scoped) =====
  const q   = (s) => document.querySelector(s);
  const qa  = (s) => Array.from(document.querySelectorAll(s));
  const cbSelectAll = () => q(SEL.selectAll);
  const delBtn      = () => q(SEL.del);

  const rowCheckboxes = () =>
    qa(SEL.anyCbs).filter(btn => !/Check all|Uncheck all/i.test(btn.getAttribute('title') || ''));

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const isChecked = (btn) => btn?.getAttribute('aria-checked') === 'true';
  const isDisabled = (btn) => {
    if (!btn) return true;
    if (btn.disabled) return true;
    if (btn.getAttribute('aria-disabled') === 'true') return true;
    const cs = getComputedStyle(btn);
    return cs.pointerEvents === 'none' || cs.visibility === 'hidden' || cs.opacity === '0';
  };

  const until = async (pred, timeout = 2 * s, step = 50) => {
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
    // simulate a full user click sequence
    ['pointerover','mouseover','pointerdown','mousedown','pointerup','mouseup','click']
      .forEach(type => el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, buttons: 1
      })));
  };

  const trySelectAll = async () => {
    const btn = cbSelectAll();
    if (!btn) return false;
    if (isChecked(btn)) return true;
    strongClick(btn);
    const ok = await until(() => isChecked(cbSelectAll()), 2 * s);
    return ok;
  };

  const trySelectOneRow = async () => {
    const rows = rowCheckboxes();
    if (!rows.length) return false;
    // pick the first unchecked
    const target = rows.find(btn => !isChecked(btn)) || rows[0];
    strongClick(target);
    const ok = await until(() => isChecked(target) || !isDisabled(delBtn()), 2 * s);
    return ok;
  };

  const ensureSelection = async () => {
    // 1) Prefer select-all
    if (await trySelectAll()) return true;
    // 2) Fallback: select at least one row checkbox
    if (await trySelectOneRow()) return true;
    return false;
  };

  (async function run() {
    let i = 0;
    console.log(`[delete-loop] start: delay=${CFG.RETRY_DELAY / s}s, enableTimeout=${CFG.ENABLE_TIMEOUT / s}s`);
    while (i++ < CFG.LOOP_CAP && !window.__stopDeleteLoop) {
      const del = delBtn();
      if (!del) { console.log('[delete-loop] delete button not found; stopping.'); break; }

      // Ensure at least one item is selected
      const selected = await ensureSelection();
      if (!selected) {
        console.log('[delete-loop] could not select any messages; retrying after delay …');
        await sleep(CFG.RETRY_DELAY);
        continue;
      }

      // Wait for Delete to enable; if not, nudge by toggling one row
      let enabled = await until(() => !isDisabled(delBtn()), CFG.ENABLE_TIMEOUT);
      if (!enabled) {
        // nudge: toggle a row checkbox
        const rows = rowCheckboxes();
        if (rows.length) {
          strongClick(rows[0]); await sleep(200);
          strongClick(rows[0]); await sleep(200);
          enabled = await until(() => !isDisabled(delBtn()), 3 * s);
        }
      }
      if (!enabled) {
        console.log('[delete-loop] delete stayed disabled; waiting and retrying …');
        await sleep(CFG.RETRY_DELAY);
        continue;
      }

      // Click Delete
      strongClick(delBtn());
      console.log(`[delete-loop] clicked delete (iter ${i}); sleeping ${CFG.RETRY_DELAY / s}s …`);
      await sleep(CFG.RETRY_DELAY);

      // If a confirm modal appears, try to accept it (best-effort)
      const confirmBtn =
        q('button[aria-label="Delete"]') ||
        q('button[data-test-id="ok"]') ||
        q('button[data-action="confirm"]');
      if (confirmBtn && !isDisabled(confirmBtn)) {
        strongClick(confirmBtn);
        await sleep(500);
      }

      // Wait a bit for UI to settle (list shrink, toolbar update)
      await until(() => isDisabled(delBtn()) || !isChecked(cbSelectAll()) || rowCheckboxes().every(b => !isChecked(b)), 4 * s);

      await sleep(200); // tiny pause before next loop
    }
    console.log('[delete-loop] finished. To stop early set: window.__stopDeleteLoop = true');
  })();
})();
