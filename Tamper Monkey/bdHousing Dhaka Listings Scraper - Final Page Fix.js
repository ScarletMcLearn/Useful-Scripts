// ==UserScript==
// @name         bdHousing Dhaka Listings Scraper - Final Page Fix
// @namespace    https://www.bdhousing.com/
// @version      2.1.0
// @description  Scrapes all bdHousing Dhaka listing pages by real page navigation and downloads CSV on the final page.
// @match        https://www.bdhousing.com/homes/listings/Dhaka*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const UI_ID = 'tm-bdhousing-scraper-ui';
  const BTN_ID = 'tm-bdhousing-scraper-btn';
  const STOP_BTN_ID = 'tm-bdhousing-scraper-stop-btn';
  const STATUS_ID = 'tm-bdhousing-scraper-status';
  const STORAGE_KEY = 'tm_bdhousing_scraper_state_v21';

  if (window.top !== window.self) return;

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

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function clearState() {
    localStorage.removeItem(STORAGE_KEY);
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
        width: 260px;
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

  function getCurrentPageNumber() {
    const url = new URL(location.href);
    const raw = url.searchParams.get('page');
    const page = parseInt(raw || '1', 10);
    return Number.isFinite(page) && page > 0 ? page : 1;
  }

  function getTitleWithoutBadge(titleEl) {
    if (!titleEl) return '';
    const clone = titleEl.cloneNode(true);
    clone.querySelectorAll('.badge, .ribbon, script, style').forEach(el => el.remove());
    return getText(clone);
  }

  function parseInfoBlocks(card) {
    const info = {};
    card.querySelectorAll('.content-info .listing-info').forEach(block => {
      const key = getText(block.querySelector('.title'));
      const value =
        getText(block.querySelector('.number')) ||
        cleanText(block.textContent.replace(key, ''));

      if (key) {
        const safeKey = key
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');

        info[`info_${safeKey}`] = value;
      }
    });
    return info;
  }

  function parseListingCard(card, pageUrl, pageNumber, indexOnPage) {
    const titleEl = card.querySelector('h1.title, h1.fix_title');
    const title = getTitleWithoutBadge(titleEl);
    const transactionType = getText(titleEl?.querySelector('.badge'));

    const propertyType =
      getText(card.querySelector('p.property .badge')) ||
      getText(card.querySelector('.property .badge'));

    const locationText = getText(card.querySelector('p.location'));
    const priceText = getText(card.querySelector('.listing-list-photo .control-label1'));

    const detailsLink =
      card.querySelector('a.img-link[href]') ||
      card.querySelector('a[href*="/details/"]');

    const detailUrl = absUrl(detailsLink?.getAttribute('href') || '', pageUrl);
    const listingIdMatch = detailUrl.match(/\/details\/(\d+)/);
    const listingId = listingIdMatch ? listingIdMatch[1] : '';

    const listingImageUrl = absUrl(
      card.querySelector('.listing-list-photo img')?.getAttribute('src') || '',
      pageUrl
    );

    const featured = getText(card.querySelector('.ribbon span'));
    const companyName = getText(card.querySelector('.content-author1 .media-heading'));

    const ownerProfileUrl = absUrl(
      card.querySelector('.content-author1 .author > a.link_overlay[href]')?.getAttribute('href') || '',
      pageUrl
    );

    const ownerSpans = Array.from(card.querySelectorAll('.property-owner span'))
      .map(el => getText(el))
      .filter(Boolean);

    const ownerType = ownerSpans[0] || '';
    const postedAt = ownerSpans.slice(1).join(' | ');

    const developerLogoUrl = absUrl(
      card.querySelector('.content-author1 .media-left img')?.getAttribute('src') || '',
      pageUrl
    );

    const hasPremiumBadge = !!card.querySelector('.member img');
    const info = parseInfoBlocks(card);

    return {
      source_page_url: pageUrl,
      page_number: pageNumber,
      item_index_on_page: indexOnPage,
      listing_id: listingId,
      title,
      transaction_type: transactionType,
      property_type: propertyType,
      location: locationText,
      price_text: priceText,
      detail_url: detailUrl,
      listing_image_url: listingImageUrl,
      featured_label: featured,
      company_name: companyName,
      owner_type: ownerType,
      posted_at: postedAt,
      owner_profile_url: ownerProfileUrl,
      developer_logo_url: developerLogoUrl,
      premium_badge: hasPremiumBadge ? 'Yes' : 'No',
      ...info
    };
  }

  function extractRowsFromCurrentPage() {
    const cards = Array.from(document.querySelectorAll('.listChildTr'));
    const pageUrl = location.href;
    const pageNumber = getCurrentPageNumber();

    return cards.map((card, idx) =>
      parseListingCard(card, pageUrl, pageNumber, idx + 1)
    );
  }

  function isDisabledPaginationLink(anchor) {
    if (!anchor) return true;

    const href = (anchor.getAttribute('href') || '').trim().toLowerCase();
    const li = anchor.closest('li');

    if (!href) return true;
    if (href === '#' || href.startsWith('javascript:')) return true;
    if (anchor.classList.contains('disabled')) return true;
    if (li && li.classList.contains('disabled')) return true;
    if (anchor.getAttribute('aria-disabled') === 'true') return true;

    return false;
  }

  function getNextPageUrl() {
    let nextAnchor = document.querySelector('a[rel="next"]');

    if (!nextAnchor) {
      nextAnchor = Array.from(document.querySelectorAll('a[href]')).find(a =>
        /next/i.test(getText(a))
      );
    }

    if (!nextAnchor) return '';

    if (isDisabledPaginationLink(nextAnchor)) {
      return '';
    }

    const href = nextAnchor.getAttribute('href');
    const nextUrl = absUrl(href, location.href);

    if (!nextUrl) return '';
    if (nextUrl === location.href) return '';

    return nextUrl;
  }

  function dedupeRows(rows) {
    const seen = new Set();
    const out = [];

    for (const row of rows) {
      const key =
        row.listing_id ||
        row.detail_url ||
        `${row.title}|${row.location}|${row.page_number}|${row.item_index_on_page}`;

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

    const lines = [headers.map(escapeCsv).join(',')];

    for (const row of rows) {
      lines.push(headers.map(h => escapeCsv(row[h] ?? '')).join(','));
    }

    return '\uFEFF' + lines.join('\r\n');
  }

  function downloadCsv(rows) {
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');

    const fileName =
      `bdhousing_dhaka_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
      `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.csv`;

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function finalizeAndDownload(state) {
    const finalRows = dedupeRows(state.rows || []);
    setStatus(`Finished. Downloading ${finalRows.length} rows...`);
    await sleep(300);
    downloadCsv(finalRows);
    clearState();
    setStatus(`Done. Exported ${finalRows.length} rows.`);
  }

  async function startScrape() {
    const existing = loadState();
    if (existing?.running) {
      setStatus(`Already running. ${existing.rows?.length || 0} rows saved so far.`);
      return;
    }

    const state = {
      running: true,
      startedAt: new Date().toISOString(),
      startUrl: location.href,
      rows: [],
      visitedPages: [],
      lastPageScraped: 0
    };

    saveState(state);
    setStatus('Started scraping...');
    await sleep(300);
    await continueScrape();
  }

  function stopScrape() {
    clearState();
    setStatus('Stopped and reset.');
  }

  async function continueScrape() {
    const state = loadState();
    if (!state?.running) return;

    const currentUrl = location.href;
    const currentPage = getCurrentPageNumber();

    if (state.visitedPages.includes(currentUrl)) {
      await finalizeAndDownload(state);
      return;
    }

    setStatus(`Scraping page ${currentPage}...`);
    await sleep(500);

    const pageRows = extractRowsFromCurrentPage();
    state.rows = dedupeRows([...(state.rows || []), ...pageRows]);
    state.visitedPages.push(currentUrl);
    state.lastPageScraped = currentPage;
    saveState(state);

    const nextUrl = getNextPageUrl();

    if (!nextUrl) {
      await finalizeAndDownload(state);
      return;
    }

    if (state.visitedPages.includes(nextUrl)) {
      await finalizeAndDownload(state);
      return;
    }

    setStatus(`Page ${currentPage} done. Moving to next page...`);
    await sleep(800);
    window.location.href = nextUrl;
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

  async function autoResumeIfNeeded() {
    const state = loadState();
    if (!state?.running) return;

    setStatus(`Resuming... ${state.rows?.length || 0} rows saved.`);
    await sleep(700);
    await continueScrape();
  }

  addUI();
  wireEvents();
  autoResumeIfNeeded();
})();
