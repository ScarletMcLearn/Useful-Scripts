(async () => {
  /* =========================
   * CONFIG — tweak here only
   * ========================= */
  const CONFIG = {
    // ----- Core limits -----
    maxCycles: null,                 // null = unlimited cycles (runs until endConfirm says "done")
    maxUsers: null,                  // number or null (no cap)

    // ----- Normal scrolling cadence -----
    waitBetweenMs: 1200,             // wait after each full-bottom scroll
    retriesPerCycle: 6,              // quick retries inside each cycle if no growth
    retryWaitMs: 600,                // wait between those quick retries
    smoothScroll: false,
    scrollNudgePx: 400,

    // ----- Long end confirmation (your ask) -----
    // After we *think* we’re at the end, keep checking in short intervals for a long time.
    endConfirm: {
      enabled: true,
      maxMs: 30 * 60 * 1000,        // keep probing for up to 30 minutes
      intervalMs: 900,              // short wait between probes
      wigglePx: 300,                // tiny scroll nudges to trigger lazy loads
      logEveryNChecks: 20           // progress log frequency during end-confirm
    },

    // ----- Selectors (adjust if IG changes DOM) -----
    dialogSelector: 'div[role="dialog"][aria-modal="true"], div[role="dialog"]',
    scrollerSelector: '',            // if '', we auto-detect
    anchorQuery: 'a[href^="/"]',

    // ----- Username rules -----
    singleSegmentProfiles: true,     // only accept /username/ (not /explore/…)
    dedupeCaseInsensitive: true,

    // ----- Export -----
    export: {
      copyToClipboard: true,
      alsoDownloadFile: true,
      filenamePrefix: 'ig_following',
      separator: '\n'
    },

    // ----- Logging -----
    logEveryNCycles: 1,
    debug: true
  };

  /* ==============
   * Runtime guard
   * ============== */
  // Allow manual stop from console: window.IGX_STOP = true
  Object.defineProperty(window, "IGX_STOP", {
    configurable: true,
    get: () => window.__IGX_STOP__ === true,
    set: v => (window.__IGX_STOP__ = Boolean(v))
  });

  /* ==============
   * Helpers
   * ============== */
  const log = (...a) => CONFIG.debug && console.log("[IGX]", ...a);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function getDialog() {
    return document.querySelector(CONFIG.dialogSelector);
  }

  function getScrollableRoot(dialog) {
    if (!dialog) return null;
    if (CONFIG.scrollerSelector) {
      const el = dialog.querySelector(CONFIG.scrollerSelector);
      if (el) return el;
    }
    const els = [dialog, ...dialog.querySelectorAll("div,section,article,main,aside")];
    for (const el of els) {
      const cs = getComputedStyle(el);
      const scrollable = (cs.overflowY === "auto" || cs.overflowY === "scroll");
      if (scrollable && el.scrollHeight > el.clientHeight + 8) return el;
    }
    return dialog;
  }

  function isProfilePath(pathname) {
    const segs = pathname.split("/").filter(Boolean);
    return CONFIG.singleSegmentProfiles ? (segs.length === 1) : (segs.length >= 1);
  }

  function extractUsernameFromAnchor(a) {
    try {
      const u = new URL(a.getAttribute("href"), location.origin);
      if (!isProfilePath(u.pathname)) return null;
      const username = u.pathname.replaceAll("/", "");
      return username || null;
    } catch {
      return null;
    }
  }

  function collectUsernames(root) {
    const anchors = root.querySelectorAll(CONFIG.anchorQuery);
    const found = [];
    for (const a of anchors) {
      const name = extractUsernameFromAnchor(a);
      if (name) found.push(name);
    }
    return found;
  }

  function atBottom(scroller) {
    return Math.abs(scroller.scrollTop + scroller.clientHeight - scroller.scrollHeight) < 2;
    // (IG sometimes keeps increasing scrollHeight after a tick; we still probe below.)
  }

  function normalize(name) {
    return CONFIG.dedupeCaseInsensitive ? name.toLowerCase() : name;
  }

  async function exportResults(list) {
    const text = list.join(CONFIG.export.separator);
    if (CONFIG.export.copyToClipboard) {
      try {
        await navigator.clipboard.writeText(text);
        log("Copied to clipboard.");
      } catch {
        log("Clipboard write failed; will download a file instead.");
      }
    }
    if (CONFIG.export.alsoDownloadFile || !CONFIG.export.copyToClipboard) {
      const blob = new Blob([text], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${CONFIG.export.filenamePrefix}_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  async function longEndConfirmation(scroller, dialog, dedupe, results) {
    if (!CONFIG.endConfirm.enabled) return true; // treat as confirmed end

    log("Entering long end-confirmation…");
    const start = Date.now();
    let checks = 0;
    let lastCount = results.length;

    while (!window.IGX_STOP && (Date.now() - start) < CONFIG.endConfirm.maxMs) {
      // Wiggle & probe the bottom
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: CONFIG.smoothScroll ? "smooth" : "auto" });
      scroller.scrollBy({ top: -CONFIG.endConfirm.wigglePx, behavior: "auto" });
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });

      await sleep(CONFIG.endConfirm.intervalMs);

      // Re-collect in case new nodes arrived
      const newly = collectUsernames(dialog);
      let grew = false;
      for (const u of newly) {
        const key = normalize(u);
        if (!dedupe.has(key)) {
          dedupe.add(key);
          results.push(u);
          grew = true;
        }
      }

      checks++;
      if (checks % CONFIG.endConfirm.logEveryNChecks === 0) {
        log(`End-confirm checks=${checks}, total=${results.length}`);
      }

      if (grew) {
        log("New usernames appeared during end-confirm; resuming main loop.");
        return false; // not at the end after all
      }

      // Some UIs append content asynchronously—double-hit the bottom
      if (!atBottom(scroller)) continue;
      // Still nothing new—keep probing until maxMs expires
    }
    log("Long end-confirmation finished with no new usernames.");
    return true; // confirmed end
  }

  /* ==============
   * Main
   * ============== */
  const dialog = getDialog();
  if (!dialog) {
    console.warn("[IGX] Open the 'Following' modal first, then run this.");
    return;
  }
  const scroller = getScrollableRoot(dialog);
  if (!scroller) {
    console.warn("[IGX] Could not find a scrollable container inside the dialog.");
    return;
  }

  const dedupe = new Set();
  const results = [];

  let lastCount = 0;
  let noGrowthCycles = 0;

  log("Starting collection… Tip: set window.IGX_STOP = true to stop.");

  for (let cycle = 1; !window.IGX_STOP && (CONFIG.maxCycles == null || cycle <= CONFIG.maxCycles); cycle++) {
    // 1) Collect before scroll
    for (const u of collectUsernames(dialog)) {
      const key = normalize(u);
      if (!dedupe.has(key)) {
        dedupe.add(key);
        results.push(u);
      }
    }

    let grew = results.length > lastCount;
    lastCount = results.length;

    // 2) If no growth, do quick retries inside the cycle
    if (!grew) {
      for (let r = 1; r <= CONFIG.retriesPerCycle && !grew && !window.IGX_STOP; r++) {
        scroller.scrollBy({ top: Math.min(CONFIG.scrollNudgePx, scroller.clientHeight - 20), behavior: CONFIG.smoothScroll ? "smooth" : "auto" });
        await sleep(CONFIG.retryWaitMs);
        for (const u of collectUsernames(dialog)) {
          const key = normalize(u);
          if (!dedupe.has(key)) {
            dedupe.add(key);
            results.push(u);
          }
        }
        grew = results.length > lastCount;
        lastCount = results.length;
      }
    }

    // 3) Full-bottom scroll to request the next page
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: CONFIG.smoothScroll ? "smooth" : "auto" });
    await sleep(CONFIG.waitBetweenMs);

    // 4) Progress & stop conditions
    if (cycle % CONFIG.logEveryNCycles === 0) {
      log(`Cycle ${cycle}: total=${results.length}`);
    }

    if (!grew) {
      noGrowthCycles++;
    } else {
      noGrowthCycles = 0;
    }

    if (CONFIG.maxUsers && results.length >= CONFIG.maxUsers) {
      log(`Hit maxUsers=${CONFIG.maxUsers}. Stopping.`);
      break;
    }

    // 5) If we seem to be at the end, run the long end-confirm
    if (atBottom(scroller) && noGrowthCycles >= 2) {
      const confirmed = await longEndConfirmation(scroller, dialog, dedupe, results);
      if (confirmed) {
        log("Confirmed list end. Stopping.");
        break;
      } else {
        // We found more during end-confirm; continue main loop.
        noGrowthCycles = 0;
      }
    }
  }

  log(`Done. Collected ${results.length} usernames.`);
  await exportResults(results);

  // Return the list for convenience
  results;
})();
