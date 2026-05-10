// ==UserScript==
// @name         LinkedIn Search Post Scraper Widget - Full Expand Fixed
// @namespace    local.linkedin.search.scraper
// @version      1.6.0
// @description  Collapsible LinkedIn post search scraper with pause/stop/download CSV/JSON and better "... more" expansion.
// @match        https://www.linkedin.com/search/results/content/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const HOST_ID = "li-post-scraper-inline-safe";

  if (document.getElementById(HOST_ID)) return;

  const CONFIG = {
    defaultDaysBack: 7,
    defaultBoundary: 10,
    defaultScrollDelayMs: 2500,
    maxNoNewRounds: 20,
    scrollPixels: Math.floor(window.innerHeight * 0.9),
  };

  const state = {
    running: false,
    paused: false,
    stopped: false,
    collapsed: true,
    results: new Map(),
    processedKeys: new Set(),
    outsideStreak: 0,
    totalScanned: 0,
    noNewRounds: 0,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const cleanText = (value) =>
    String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const absoluteUrl = (href) => {
    if (!href) return "";
    try {
      return new URL(href, location.origin).href;
    } catch {
      return href;
    }
  };

  const normalizeLinkedInRedirect = (url) => {
    try {
      const u = new URL(url, location.origin);

      if (u.pathname.includes("/safety/go/") && u.searchParams.get("url")) {
        return decodeURIComponent(u.searchParams.get("url"));
      }

      return u.href;
    } catch {
      return url || "";
    }
  };

  function getSinceDate(daysBack) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - Number(daysBack || 0));
    return d;
  }

  function parseRelativePostTime(text) {
    const raw = cleanText(text).toLowerCase();
    const match = raw.match(/\b(\d+)\s*(m|h|d|w|mo|yr|y)\b/);

    if (!match) return { raw: text, date: null };

    const amount = Number(match[1]);
    const unit = match[2];
    const date = new Date();

    if (unit === "m") date.setMinutes(date.getMinutes() - amount);
    if (unit === "h") date.setHours(date.getHours() - amount);
    if (unit === "d") date.setDate(date.getDate() - amount);
    if (unit === "w") date.setDate(date.getDate() - amount * 7);
    if (unit === "mo") date.setMonth(date.getMonth() - amount);
    if (unit === "yr" || unit === "y") date.setFullYear(date.getFullYear() - amount);

    return { raw: text, date };
  }

  function isInDateRange(timeInfo, daysBack) {
    if (!timeInfo || !timeInfo.date) return true;
    return timeInfo.date >= getSinceDate(daysBack);
  }

  function getPostCards() {
    const cards = new Set();

    document.querySelectorAll("h2, span").forEach((el) => {
      if (cleanText(el.textContent) === "Feed post") {
        const card =
          el.closest('[role="listitem"]') ||
          el.closest("li") ||
          el.closest("article") ||
          el.closest("div[componentkey]");

        if (card) cards.add(card);
      }
    });

    document.querySelectorAll('[data-testid="expandable-text-box"]').forEach((el) => {
      const card =
        el.closest('[role="listitem"]') ||
        el.closest("li") ||
        el.closest("article") ||
        el.closest("div[componentkey]");

      if (card) cards.add(card);
    });

    return Array.from(cards).filter((card) => card && card.offsetParent !== null);
  }

  function getPostText(card) {
    const body = card.querySelector('[data-testid="expandable-text-box"]');
    return cleanText(body ? body.innerText || body.textContent : "");
  }

  function getMoreButtons(card) {
    const candidates = Array.from(
      card.querySelectorAll('button, [role="button"], span, div')
    );

    const moreButtons = [];

    for (const el of candidates) {
      const text = cleanText(el.innerText || el.textContent || "");
      const aria = cleanText(el.getAttribute("aria-label") || "");

      const textLooksLikeMore =
        /^(…|\.\.\.)?\s*(more|see more|show more)$/i.test(text);

      const ariaLooksLikeMore =
        /\b(see more|show more|more)\b/i.test(aria);

      if (!textLooksLikeMore && !ariaLooksLikeMore) continue;

      const clickable = el.closest('button, [role="button"]') || el;

      if (!card.contains(clickable)) continue;

      if (!moreButtons.includes(clickable)) {
        moreButtons.push(clickable);
      }
    }

    return moreButtons;
  }

  function forceClick(el) {
    try {
      el.scrollIntoView({
        block: "center",
        inline: "nearest",
      });
    } catch {
      // ignore
    }

    try {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    } catch {
      try {
        el.click();
      } catch {
        // ignore
      }
    }
  }

  async function waitForExpandedText(card, beforeText, timeoutMs = 3000) {
    const startedAt = Date.now();
    const beforeLength = cleanText(beforeText).length;

    while (Date.now() - startedAt < timeoutMs) {
      await sleep(150);

      const currentText = getPostText(card);
      const currentLength = cleanText(currentText).length;
      const stillHasMoreButton = getMoreButtons(card).length > 0;

      if (currentLength > beforeLength + 20) return true;
      if (!stillHasMoreButton && currentLength >= beforeLength) return true;
    }

    return false;
  }

  async function expandPost(card) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const beforeText = getPostText(card);
      const moreButtons = getMoreButtons(card);

      if (!moreButtons.length) return;

      for (const btn of moreButtons) {
        forceClick(btn);
        await sleep(350);
      }

      await waitForExpandedText(card, beforeText, 3000);

      const afterText = getPostText(card);

      if (afterText.length > beforeText.length + 20) return;
      if (!getMoreButtons(card).length) return;
    }
  }

  function getAuthor(card) {
    const profileLinks = Array.from(card.querySelectorAll('a[href*="/in/"]'));

    const profileLink =
      profileLinks.find((a) => {
        const txt = cleanText(a.innerText || a.textContent);
        return txt && !txt.toLowerCase().includes("view");
      }) || profileLinks[0];

    const authorText = profileLink
      ? cleanText(profileLink.innerText || profileLink.textContent)
      : "";

    const authorName =
      authorText
        .split("\n")
        .map(cleanText)
        .find(
          (line) =>
            line &&
            !line.includes("•") &&
            !line.toLowerCase().includes("verified") &&
            !line.toLowerCase().includes("follow") &&
            !line.toLowerCase().includes("connect")
        ) || "";

    return {
      authorName,
      authorProfileUrl: profileLink ? absoluteUrl(profileLink.getAttribute("href")) : "",
    };
  }

  function getTimeText(card) {
    const text = cleanText(card.innerText || card.textContent);

    const match = text.match(/\b\d+\s*(m|h|d|w|mo|yr|y)\s*•/i);
    if (match) return cleanText(match[0].replace("•", ""));

    const fallback = text.match(/\b\d+\s*(m|h|d|w|mo|yr|y)\b/i);
    return fallback ? cleanText(fallback[0]) : "";
  }

  function getLinks(card) {
    const links = Array.from(card.querySelectorAll("a[href]"))
      .map((a) => normalizeLinkedInRedirect(absoluteUrl(a.getAttribute("href"))))
      .filter(Boolean)
      .filter((href) => !href.startsWith("javascript:"));

    return Array.from(new Set(links));
  }

  function getImages(card) {
    const images = Array.from(card.querySelectorAll("img[src]"))
      .map((img) => ({
        src: absoluteUrl(img.getAttribute("src")),
        alt: cleanText(img.getAttribute("alt") || ""),
      }))
      .filter((img) => img.src)
      .filter((img) => {
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        const isPostImage = img.alt.toLowerCase().includes("view image");
        return isPostImage || w >= 120 || h >= 120;
      });

    const seen = new Set();

    return images.filter((img) => {
      if (seen.has(img.src)) return false;
      seen.add(img.src);
      return true;
    });
  }

  function getEmails(text) {
    const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    return Array.from(new Set(matches));
  }

  function makePostKey(data) {
    return [
      data.authorProfileUrl,
      data.timeText,
      data.text.slice(0, 180),
      data.links.slice(0, 3).join("|"),
    ].join("::");
  }

  async function scrapeCard(card, daysBack) {
    await expandPost(card);
    await sleep(300);

    const author = getAuthor(card);
    const text = getPostText(card);
    const timeText = getTimeText(card);
    const timeInfo = parseRelativePostTime(timeText);
    const links = getLinks(card);
    const images = getImages(card);
    const emails = getEmails(text);

    const data = {
      scrapedAt: new Date().toISOString(),
      searchUrl: location.href,
      authorName: author.authorName,
      authorProfileUrl: author.authorProfileUrl,
      timeText,
      estimatedPostDate: timeInfo.date ? timeInfo.date.toISOString() : "",
      inSelectedRange: isInDateRange(timeInfo, daysBack),
      text,
      emails,
      links,
      images: images.map((img) => img.src),
      imageAlts: images.map((img) => img.alt),
    };

    data.key = makePostKey(data);
    return data;
  }

  function getScrollableElements() {
    const baseCandidates = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      document.querySelector("main"),
      document.querySelector(".scaffold-layout__main"),
      document.querySelector(".scaffold-layout__content"),
      document.querySelector(".scaffold-layout__list"),
      document.querySelector(".search-results-container"),
    ].filter(Boolean);

    const allScrollable = Array.from(document.querySelectorAll("main, div, section"))
      .filter((el) => {
        try {
          const style = window.getComputedStyle(el);
          const overflowY = style.overflowY;
          const canOverflow = ["auto", "scroll", "overlay"].includes(overflowY);
          return canOverflow && el.scrollHeight > el.clientHeight + 200;
        } catch {
          return false;
        }
      })
      .slice(0, 20);

    return Array.from(new Set([...baseCandidates, ...allScrollable])).filter(Boolean);
  }

  async function scrollLinkedInPage() {
    const targets = getScrollableElements();

    const beforeWindowY = window.scrollY;
    const beforeDocHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );

    const beforePositions = new Map();

    for (const target of targets) {
      beforePositions.set(target, {
        top: target.scrollTop || 0,
        height: target.scrollHeight || 0,
      });
    }

    window.scrollBy({
      top: CONFIG.scrollPixels,
      left: 0,
      behavior: "smooth",
    });

    for (const target of targets) {
      try {
        target.scrollBy({
          top: CONFIG.scrollPixels,
          left: 0,
          behavior: "smooth",
        });
      } catch {
        try {
          target.scrollTop = (target.scrollTop || 0) + CONFIG.scrollPixels;
        } catch {
          // ignore
        }
      }
    }

    await sleep(1200);

    let moved = window.scrollY !== beforeWindowY;
    let heightChanged =
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) !== beforeDocHeight;

    for (const target of targets) {
      const before = beforePositions.get(target);
      if (!before) continue;

      if ((target.scrollTop || 0) !== before.top) moved = true;
      if ((target.scrollHeight || 0) !== before.height) heightChanged = true;
    }

    if (!moved) {
      window.scrollTo(0, beforeWindowY + CONFIG.scrollPixels);

      for (const target of targets) {
        try {
          const before = beforePositions.get(target);
          target.scrollTop = (before?.top || 0) + CONFIG.scrollPixels;
        } catch {
          // ignore
        }
      }

      await sleep(1000);

      if (window.scrollY !== beforeWindowY) moved = true;

      for (const target of targets) {
        const before = beforePositions.get(target);
        if (!before) continue;
        if ((target.scrollTop || 0) !== before.top) moved = true;
        if ((target.scrollHeight || 0) !== before.height) heightChanged = true;
      }
    }

    return { moved, heightChanged };
  }

  function el(tag, text = "") {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }

  function apply(node, styles) {
    Object.assign(node.style, styles);
    return node;
  }

  const host = apply(el("div"), {
    position: "fixed",
    right: "18px",
    bottom: "18px",
    zIndex: "2147483647",
    fontFamily: "Arial, sans-serif",
    color: "#111827",
  });

  host.id = HOST_ID;
  document.body.appendChild(host);

  const collapsedButton = apply(el("button"), {
    width: "245px",
    height: "58px",
    border: "0",
    borderRadius: "999px",
    background: "linear-gradient(135deg, #0a66c2, #004182)",
    color: "#ffffff",
    boxShadow: "0 16px 40px rgba(0,0,0,0.28)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 13px",
    fontFamily: "Arial, sans-serif",
  });

  const collapsedLeft = apply(el("div"), {
    display: "flex",
    alignItems: "center",
    gap: "9px",
  });

  const logo = apply(el("div", "in"), {
    width: "32px",
    height: "32px",
    borderRadius: "999px",
    background: "rgba(255,255,255,0.18)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: "900",
    fontSize: "14px",
  });

  const titleBox = el("div");

  const title = apply(el("div", "Post Scraper"), {
    fontSize: "14px",
    fontWeight: "800",
    lineHeight: "1.1",
    textAlign: "left",
  });

  const mini = apply(el("div", "0 saved"), {
    fontSize: "11px",
    opacity: "0.9",
    marginTop: "3px",
    textAlign: "left",
  });

  const plus = apply(el("div", "+"), {
    width: "28px",
    height: "28px",
    borderRadius: "999px",
    background: "rgba(255,255,255,0.18)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "20px",
    fontWeight: "900",
  });

  titleBox.append(title, mini);
  collapsedLeft.append(logo, titleBox);
  collapsedButton.append(collapsedLeft, plus);

  const panel = apply(el("div"), {
    width: "365px",
    background: "#ffffff",
    border: "1px solid rgba(15,23,42,0.16)",
    borderRadius: "18px",
    boxShadow: "0 18px 45px rgba(15,23,42,0.28)",
    overflow: "hidden",
    display: "none",
    fontFamily: "Arial, sans-serif",
  });

  const header = apply(el("div"), {
    height: "58px",
    background: "linear-gradient(135deg, #0a66c2, #004182)",
    color: "#ffffff",
    padding: "10px 12px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    cursor: "pointer",
    userSelect: "none",
  });

  const headerLeft = collapsedLeft.cloneNode(true);

  const minus = apply(el("button", "−"), {
    width: "28px",
    height: "28px",
    border: "0",
    borderRadius: "999px",
    background: "rgba(255,255,255,0.18)",
    color: "#ffffff",
    fontSize: "20px",
    fontWeight: "900",
    cursor: "pointer",
    padding: "0",
  });

  header.append(headerLeft, minus);

  const body = apply(el("div"), {
    padding: "13px",
    background: "#ffffff",
  });

  function makeLabel(labelText, inputClass, value, min, step = "1") {
    const label = apply(el("label"), {
      display: "block",
      marginBottom: "9px",
      fontSize: "12px",
      fontWeight: "700",
      color: "#374151",
    });

    const input = apply(el("input"), {
      width: "100%",
      marginTop: "5px",
      padding: "8px 9px",
      border: "1px solid #d1d5db",
      borderRadius: "10px",
      background: "#ffffff",
      color: "#111827",
      fontSize: "13px",
      outline: "none",
      fontFamily: "Arial, sans-serif",
    });

    input.className = inputClass;
    input.type = "number";
    input.min = min;
    input.step = step;
    input.value = value;

    label.append(labelText, input);
    return label;
  }

  const grid = apply(el("div"), {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "9px",
  });

  grid.append(
    makeLabel("Days back", "days-back", CONFIG.defaultDaysBack, "0"),
    makeLabel("Boundary N", "boundary", CONFIG.defaultBoundary, "1")
  );

  const delayLabel = makeLabel(
    "Scroll delay ms",
    "scroll-delay",
    CONFIG.defaultScrollDelayMs,
    "500",
    "100"
  );

  const actions = apply(el("div"), {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "8px",
    marginTop: "10px",
  });

  function makeActionButton(text, className, bg, color = "#ffffff") {
    const button = apply(el("button", text), {
      border: "0",
      borderRadius: "11px",
      padding: "9px 10px",
      fontSize: "12px",
      fontWeight: "800",
      cursor: "pointer",
      background: bg,
      color,
      fontFamily: "Arial, sans-serif",
    });

    button.className = className;
    return button;
  }

  const startBtn = makeActionButton("Start", "start", "#0a66c2");
  const pauseBtn = makeActionButton("Pause", "pause", "#eef2f7", "#111827");
  const stopBtn = makeActionButton("Stop", "stop", "#dc2626");
  const csvBtn = makeActionButton("CSV", "csv", "#16a34a");
  const jsonBtn = makeActionButton("JSON", "json", "#4f46e5");

  pauseBtn.disabled = true;
  stopBtn.disabled = true;
  pauseBtn.style.opacity = "0.45";
  stopBtn.style.opacity = "0.45";

  actions.append(startBtn, pauseBtn, stopBtn, csvBtn, jsonBtn);

  const statusBox = apply(el("div"), {
    marginTop: "11px",
    padding: "10px",
    borderRadius: "12px",
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    lineHeight: "1.35",
  });

  const counts = apply(el("div", "Saved 0 • Scanned 0 • Old streak 0"), {
    fontWeight: "800",
    marginBottom: "4px",
    fontSize: "12px",
    color: "#111827",
  });

  const status = apply(el("div", "Ready."), {
    color: "#4b5563",
    fontSize: "12px",
  });

  statusBox.append(counts, status);

  const note = apply(el("div", "Best used with LinkedIn search sorted by latest/date posted."), {
    marginTop: "9px",
    fontSize: "11px",
    color: "#6b7280",
    lineHeight: "1.35",
  });

  body.append(grid, delayLabel, actions, statusBox, note);
  panel.append(header, body);
  host.append(collapsedButton, panel);

  function setCollapsed(collapsed) {
    state.collapsed = collapsed;
    collapsedButton.style.display = collapsed ? "flex" : "none";
    panel.style.display = collapsed ? "none" : "block";
  }

  function updateStatus(message) {
    const countText = `Saved ${state.results.size} • Scanned ${state.totalScanned} • Old streak ${state.outsideStreak}`;

    counts.textContent = countText;
    status.textContent = message || "";

    if (state.running && state.paused) mini.textContent = `Paused • ${state.results.size} saved`;
    else if (state.running) mini.textContent = `Running • ${state.results.size} saved`;
    else mini.textContent = `${state.results.size} saved`;
  }

  function readSettings() {
    return {
      daysBack: Math.max(0, Number(host.querySelector(".days-back").value || CONFIG.defaultDaysBack)),
      boundary: Math.max(1, Number(host.querySelector(".boundary").value || CONFIG.defaultBoundary)),
      scrollDelayMs: Math.max(500, Number(host.querySelector(".scroll-delay").value || CONFIG.defaultScrollDelayMs)),
    };
  }

  function resetRunState() {
    state.running = true;
    state.paused = false;
    state.stopped = false;
    state.results = new Map();
    state.processedKeys = new Set();
    state.outsideStreak = 0;
    state.totalScanned = 0;
    state.noNewRounds = 0;
  }

  function setButtonsForRunning(isRunning) {
    startBtn.disabled = isRunning;
    pauseBtn.disabled = !isRunning;
    stopBtn.disabled = !isRunning;

    startBtn.style.opacity = isRunning ? "0.45" : "1";
    pauseBtn.style.opacity = isRunning ? "1" : "0.45";
    stopBtn.style.opacity = isRunning ? "1" : "0.45";

    pauseBtn.textContent = "Pause";
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 500);
  }

  function escapeCsv(value) {
    const str = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
    return `"${str.replace(/"/g, '""')}"`;
  }

  function toCsv(rows) {
    const headers = [
      "scrapedAt",
      "searchUrl",
      "authorName",
      "authorProfileUrl",
      "timeText",
      "estimatedPostDate",
      "inSelectedRange",
      "text",
      "emails",
      "links",
      "images",
      "imageAlts",
    ];

    return [
      headers.join(","),
      ...rows.map((row) => headers.map((h) => escapeCsv(row[h])).join(",")),
    ].join("\n");
  }

  function getRows() {
    return Array.from(state.results.values());
  }

  function downloadCsv() {
    const rows = getRows();

    if (!rows.length) {
      updateStatus("Nothing to download yet.");
      return;
    }

    const filename = `linkedin-posts-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.csv`;

    download(filename, toCsv(rows), "text/csv;charset=utf-8");
    updateStatus(`Downloaded CSV with ${rows.length} rows.`);
  }

  function downloadJson() {
    const rows = getRows();

    if (!rows.length) {
      updateStatus("Nothing to download yet.");
      return;
    }

    const filename = `linkedin-posts-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.json`;

    download(filename, JSON.stringify(rows, null, 2), "application/json;charset=utf-8");
    updateStatus(`Downloaded JSON with ${rows.length} rows.`);
  }

  async function runScraper() {
    if (state.running) {
      updateStatus("Already running.");
      return;
    }

    setCollapsed(false);
    resetRunState();
    setButtonsForRunning(true);

    const settings = readSettings();
    updateStatus(`Started. Keeping posts from last ${settings.daysBack} day(s).`);

    while (!state.stopped) {
      while (state.paused && !state.stopped) {
        updateStatus("Paused.");
        await sleep(500);
      }

      if (state.stopped) break;

      const cards = getPostCards();
      let newThisRound = 0;

      for (const card of cards) {
        if (state.stopped || state.paused) break;

        const data = await scrapeCard(card, settings.daysBack);

        if (!data.text && !data.authorName && !data.authorProfileUrl) continue;
        if (state.processedKeys.has(data.key)) continue;

        state.processedKeys.add(data.key);
        state.totalScanned += 1;
        newThisRound += 1;

        if (data.inSelectedRange) {
          state.results.set(data.key, data);
          state.outsideStreak = 0;
        } else {
          state.outsideStreak += 1;
        }

        updateStatus("Scanning visible posts...");

        if (state.outsideStreak >= settings.boundary) {
          state.stopped = true;
          updateStatus(`Stopped: found ${settings.boundary} consecutive old posts.`);
          break;
        }

        await sleep(150);
      }

      if (state.stopped) break;

      if (newThisRound === 0) {
        state.noNewRounds += 1;
      } else {
        state.noNewRounds = 0;
      }

      if (state.noNewRounds >= CONFIG.maxNoNewRounds) {
        state.stopped = true;
        updateStatus("Stopped: no new posts detected after multiple scroll attempts.");
        break;
      }

      updateStatus("Scrolling...");
      const scrollResult = await scrollLinkedInPage();

      if (!scrollResult.moved && !scrollResult.heightChanged) {
        state.noNewRounds += 1;
        updateStatus("Scroll did not move. Retrying...");
      }

      await sleep(settings.scrollDelayMs);
    }

    state.running = false;
    state.paused = false;
    setButtonsForRunning(false);
    updateStatus(`Finished. Saved ${state.results.size} post(s).`);
  }

  collapsedButton.addEventListener("click", () => setCollapsed(false));

  header.addEventListener("click", () => setCollapsed(true));

  minus.addEventListener("click", (event) => {
    event.stopPropagation();
    setCollapsed(true);
  });

  body.addEventListener("click", (event) => event.stopPropagation());

  startBtn.addEventListener("click", runScraper);

  pauseBtn.addEventListener("click", () => {
    if (!state.running) return;

    state.paused = !state.paused;
    pauseBtn.textContent = state.paused ? "Resume" : "Pause";
    updateStatus(state.paused ? "Paused." : "Resumed.");
  });

  stopBtn.addEventListener("click", () => {
    state.stopped = true;
    state.paused = false;
    updateStatus("Stopping...");
  });

  csvBtn.addEventListener("click", downloadCsv);
  jsonBtn.addEventListener("click", downloadJson);

  setCollapsed(true);
})();
