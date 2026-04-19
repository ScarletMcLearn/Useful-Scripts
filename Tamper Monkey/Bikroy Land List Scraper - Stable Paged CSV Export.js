// ==UserScript==
// @name         Bikroy Land List Scraper - Stable Paged CSV Export
// @namespace    https://bikroy.com/
// @version      2.0.0
// @description  Scrape Bikroy land-for-sale list items across all pages and export CSV reliably
// @match        https://bikroy.com/*/ads/*/land-for-sale*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
  'use strict';

  const UI_ID = 'tm-bikroy-scraper-ui';
  const BTN_ID = 'tm-bikroy-scraper-btn';
  const STOP_BTN_ID = 'tm-bikroy-scraper-stop-btn';
  const STATUS_ID = 'tm-bikroy-scraper-status';

  const STATE_KEY = 'tm_bikroy_land_scraper_state_v2';
  const ROWS_KEY = 'tm_bikroy_land_scraper_rows_v2';

  if (window.top !== window.self) return;

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function cleanText(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function getText(el) {
    return cleanText(el?.textContent || '');
  }

  function absUrl(url, baseUrl = location.href) {
    try {
      return url ? new URL(url, baseUrl).href : '';
    } catch {
      return '';
    }
  }

  function loadState() {
    return GM_getValue(STATE_KEY, null);
  }

  function saveState(state) {
    GM_setValue(STATE_KEY, state);
  }

  function loadRows() {
    return GM_getValue(ROWS_KEY, []);
  }

  function saveRows(rows) {
    GM_setValue(ROWS_KEY, rows);
  }

  function clearAll() {
    GM_deleteValue(STATE_KEY);
    GM_deleteValue(ROWS_KEY);
  }

  function setStatus(message, isError = false) {
    const el = document.getElementById(STATUS_ID);
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? '#b91c1c' : '#111827';
  }

  function addUI() {
    if (document.getElementById(UI_ID)) return;

    const wrap = document.createElement('div');
    wrap.id = UI_ID;
    wrap.innerHTML = `
      <div style="
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 999999;
        display: flex;
        flex-direction: column;
        gap: 8px;
        background: #ffffff;
        border: 1px solid #d1d5db;
        border-radius: 12px;
        padding: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        font-family: Arial, sans-serif;
        width: 290px;
      ">
        <button id="${BTN_ID}" style="
          border: 0;
          background: #0f766e;
          color: white;
          padding: 10px 12px;
          border-radius: 8px;
          font-weight: 700;
          cursor: pointer;
        ">Scrape CSV</button>

        <button id="${STOP_BTN_ID}" style="
          border: 0;
          background: #b91c1c;
          color: white;
          padding: 10px 12px;
          border-radius: 8px;
          font-weight: 700;
          cursor: pointer;
        ">Stop / Reset</button>

        <div id="${STATUS_ID}" style="
          font-size: 12px;
          line-height: 1.4;
          color: #111827;
          word-break: break-word;
        ">Ready</div>
      </div>
    `;
    document.body.appendChild(wrap);
  }

  function getListingAnchors() {
    return Array.from(document.querySelectorAll('a[data-testid="ad-card-link"]'))
      .filter(a => {
        const href = a.getAttribute('href') || '';
        return href && !href.includes('/boost-ad');
      });
  }

  async function waitForListings(timeoutMs = 25000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const items = getListingAnchors();
      if (items.length > 0) return true;
      await sleep(500);
    }
    return false;
  }

  function getPageInfo() {
    const candidates = [
      '.single-page--1lRgs',
      '[class*="single-page--"]',
      '.pagination--1bp3g',
      'nav.wrapper--trS9a'
    ];

    let txt = '';
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      const value = getText(el);
      if (/page\s+\d+\s+of\s+\d+/i.test(value)) {
        txt = value;
        break;
      }
    }

    if (!txt) {
      txt = cleanText(document.body.innerText.match(/Page\s+\d+\s+of\s+\d+/i)?.[0] || '');
    }

    const match = txt.match(/page\s+(\d+)\s+of\s+(\d+)/i);

    let current = null;
    let total = null;

    if (match) {
      current = parseInt(match[1], 10);
      total = parseInt(match[2], 10);
    }

    if (!current) {
      const url = new URL(location.href);
      const raw = url.searchParams.get('page');
      const fallback = parseInt(raw || '1', 10);
      current = Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
    }

    return {
      current,
      total: Number.isFinite(total) && total > 0 ? total : null
    };
  }

  function getNextNavLi() {
    return (
      document.querySelector('li[aria-label="next page"]') ||
      document.querySelector('.gtm-next-page') ||
      document.querySelector('[class*="nextButton--"]')
    );
  }

  function isNextDisabled() {
    const nextLi = getNextNavLi();
    if (!nextLi) {
      const { current, total } = getPageInfo();
      return !!(total && current >= total);
    }

    const anchor = nextLi.querySelector('a');
    const classBlob = `${nextLi.className || ''} ${anchor?.className || ''}`;

    if (/disabled/i.test(classBlob)) return true;
    if (nextLi.getAttribute('aria-disabled') === 'true') return true;

    const { current, total } = getPageInfo();
    if (total && current >= total) return true;

    return false;
  }

  function buildPageUrl(pageNumber) {
    const url = new URL(location.href);
    url.searchParams.set('page', String(pageNumber));
    return url.toString();
  }

  function getNextPageUrl() {
    const { current, total } = getPageInfo();

    if (isNextDisabled()) return '';
    if (total && current >= total) return '';

    return buildPageUrl(current + 1);
  }

  function safeSplitDescription(desc) {
    const parts = desc.split(',').map(s => cleanText(s)).filter(Boolean);
    return {
      area_or_location: parts[0] || '',
      category_text: parts.slice(1).join(', ') || ''
    };
  }

  function parseCard(anchor, idxOnPage) {
    const card =
      anchor.closest('li') ||
      anchor.closest('article') ||
      anchor.parentElement;

    const href = anchor.getAttribute('href') || '';
    const detailUrl = absUrl(href, location.origin);

    const title =
      getText(anchor.querySelector('h2')) ||
      cleanText(anchor.getAttribute('title')) ||
      '';

    const image = card?.querySelector('img[src]');
    const imageUrl = absUrl(image?.getAttribute('src') || '', location.origin);
    const imageAlt = cleanText(image?.getAttribute('alt') || '');

    const sizeText =
      getText(card?.querySelector('[class*="details--"]')) || '';

    const descriptionText =
      getText(card?.querySelector('[class*="description--"]')) || '';

    const priceText =
      getText(card?.querySelector('[class*="price--"]')) || '';

    const { area_or_location, category_text } = safeSplitDescription(descriptionText);

    const isTopAd =
      !!card?.matches('[class*="top-ads-container--"]') ||
      !!card?.querySelector('[class*="top-ad--"]');

    const adSlugMatch = detailUrl.match(/\/ad\/([^/?#]+)/i);
    const adSlug = adSlugMatch ? adSlugMatch[1] : '';

    const { current } = getPageInfo();

    return {
      source_page_url: location.href,
      page_number: current,
      item_index_on_page: idxOnPage,
      title,
      detail_url: detailUrl,
      ad_slug: adSlug,
      size_text: sizeText,
      description_text: descriptionText,
      area_or_location,
      category_text,
      price_text: priceText,
      image_url: imageUrl,
      image_alt: imageAlt,
      is_top_ad: isTopAd ? 'Yes' : 'No'
    };
  }

  function extractRowsFromCurrentPage() {
    const anchors = getListingAnchors();
    const rows = [];

    anchors.forEach((a, index) => {
      const href = a.getAttribute('href') || '';
      if (!href || href.includes('/boost-ad')) return;
      rows.push(parseCard(a, index + 1));
    });

    return rows;
  }

  function dedupeRows(rows) {
    const seen = new Set();
    const out = [];

    for (const row of rows) {
      const key = row.detail_url || `${row.title}|${row.page_number}|${row.item_index_on_page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }

    return out;
  }

  function toCsv(rows) {
    if (!rows.length) return '';

    const headers = Array.from(
      rows.reduce((set, row) => {
        Object.keys(row).forEach(key => set.add(key));
        return set;
      }, new Set())
    );

    const escapeCsv = (value) => {
      const str = value == null ? '' : String(value);
      return `"${str.replace(/"/g, '""')}"`;
    };

    const lines = [];
    lines.push(headers.map(escapeCsv).join(','));

    for (const row of rows) {
      lines.push(headers.map(h => escapeCsv(row[h] ?? '')).join(','));
    }

    return '\uFEFF' + lines.join('\r\n');
  }

  function downloadCsv(rows, skippedPages) {
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');

    const suffix = skippedPages?.length ? `_with_skips_${skippedPages.join('-')}` : '';
    const fileName =
      `bikroy_land_list_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
      `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}${suffix}.csv`;

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function finalizeAndDownload() {
    const state = loadState() || {};
    const finalRows = dedupeRows(loadRows() || []);
    const skipped = Array.isArray(state.skippedPages) ? state.skippedPages : [];

    setStatus(`Downloading ${finalRows.length} rows...`);
    await sleep(300);
    downloadCsv(finalRows, skipped);
    clearAll();

    if (skipped.length) {
      setStatus(`Finished. Exported ${finalRows.length} rows. Skipped pages: ${skipped.join(', ')}`, true);
    } else {
      setStatus(`Finished. Exported ${finalRows.length} rows.`);
    }
  }

  async function continueScrape() {
    const state = loadState();
    if (!state?.running) return;

    const { current, total } = getPageInfo();

    state.lastKnownTotal = total || state.lastKnownTotal || null;
    state.pagesDone = Array.isArray(state.pagesDone) ? state.pagesDone : [];
    state.pageRetries = state.pageRetries || {};
    state.skippedPages = Array.isArray(state.skippedPages) ? state.skippedPages : [];

    saveState(state);

    // If this page was already scraped, do not finalize early.
    // Just try to move forward.
    if (state.pagesDone.includes(current)) {
      const nextUrl = getNextPageUrl();

      if (nextUrl) {
        setStatus(`Page ${current} already saved. Moving to page ${current + 1}...`);
        await sleep(900);
        window.location.assign(nextUrl);
        return;
      }

      await finalizeAndDownload();
      return;
    }

    setStatus(`Waiting for listings on page ${current}${state.lastKnownTotal ? ` of ${state.lastKnownTotal}` : ''}...`);
    const ready = await waitForListings(25000);

    if (!ready) {
      state.pageRetries[current] = (state.pageRetries[current] || 0) + 1;
      saveState(state);

      if (state.pageRetries[current] <= 2) {
        setStatus(`Page ${current} did not load properly. Retrying (${state.pageRetries[current]}/2)...`, true);
        await sleep(1200);
        window.location.reload();
        return;
      }

      const nextUrlAfterFailure = getNextPageUrl();

      if (nextUrlAfterFailure) {
        if (!state.skippedPages.includes(current)) {
          state.skippedPages.push(current);
        }
        state.pagesDone.push(current);
        state.pagesDone = Array.from(new Set(state.pagesDone)).sort((a, b) => a - b);
        saveState(state);

        setStatus(`Skipping page ${current} after retries. Moving to page ${current + 1}...`, true);
        await sleep(1200);
        window.location.assign(nextUrlAfterFailure);
        return;
      }

      await finalizeAndDownload();
      return;
    }

    setStatus(`Scraping page ${current}${state.lastKnownTotal ? ` of ${state.lastKnownTotal}` : ''}...`);
    await sleep(300);

    const pageRows = extractRowsFromCurrentPage();
    let rows = loadRows() || [];
    rows = dedupeRows(rows.concat(pageRows));
    saveRows(rows);

    state.pagesDone.push(current);
    state.pagesDone = Array.from(new Set(state.pagesDone)).sort((a, b) => a - b);
    saveState(state);

    const nextUrl = getNextPageUrl();

    if (!nextUrl) {
      await finalizeAndDownload();
      return;
    }

    setStatus(`Page ${current} done. Moving to page ${current + 1}...`);
    await sleep(1000);
    window.location.assign(nextUrl);
  }

  async function startScrape() {
    const existing = loadState();
    if (existing?.running) {
      setStatus(`Already running. ${loadRows().length || 0} rows saved so far.`);
      return;
    }

    saveState({
      running: true,
      startedAt: new Date().toISOString(),
      startUrl: location.href,
      pagesDone: [],
      pageRetries: {},
      skippedPages: [],
      lastKnownTotal: null
    });

    saveRows([]);
    setStatus('Started scraping...');
    await sleep(250);
    await continueScrape();
  }

  function stopScrape() {
    clearAll();
    setStatus('Stopped and reset.');
  }

  async function autoResumeIfNeeded() {
    const state = loadState();
    if (!state?.running) return;

    const rows = loadRows() || [];
    setStatus(`Resuming... ${rows.length} rows already saved.`);
    await sleep(700);
    await continueScrape();
  }

  function wireEvents() {
    const scrapeBtn = document.getElementById(BTN_ID);
    const stopBtn = document.getElementById(STOP_BTN_ID);

    if (scrapeBtn && !scrapeBtn.dataset.bound) {
      scrapeBtn.dataset.bound = '1';
      scrapeBtn.addEventListener('click', startScrape);
    }

    if (stopBtn && !stopBtn.dataset.bound) {
      stopBtn.dataset.bound = '1';
      stopBtn.addEventListener('click', stopScrape);
    }
  }

  addUI();
  wireEvents();
  autoResumeIfNeeded();
})();
