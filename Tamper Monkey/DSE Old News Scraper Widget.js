// ==UserScript==
// @name         DSE Old News Scraper Widget
// @namespace    https://dsebd.org/
// @version      1.0.0
// @description  Scrape DSE old_news day by day with a bottom-right widget, pause/stop, and CSV download.
// @match        *://dsebd.org/old_news.php*
// @match        *://www.dsebd.org/old_news.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const ID_PREFIX = 'tm-dse-news-scraper';
  const REQUEST_DELAY_MS = 1200;

  let isRunning = false;
  let isPaused = false;
  let stopRequested = false;
  let results = [];

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function createEl(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
      if (key === 'style') {
        Object.assign(el.style, value);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key in el) {
        el[key] = value;
      } else {
        el.setAttribute(key, value);
      }
    });
    children.forEach((child) => {
      if (child == null) return;
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return el;
  }

  function injectStyles() {
    if (document.getElementById(`${ID_PREFIX}-style`)) return;

    const style = createEl('style', {
      id: `${ID_PREFIX}-style`,
      textContent: `
        #${ID_PREFIX}-fab {
          position: fixed;
          right: 20px;
          bottom: 20px;
          z-index: 999999;
          background: #0b5ed7;
          color: #fff;
          border: none;
          border-radius: 999px;
          padding: 12px 18px;
          font: 600 14px/1.2 Arial, sans-serif;
          cursor: pointer;
          box-shadow: 0 8px 24px rgba(0,0,0,.25);
        }

        #${ID_PREFIX}-panel {
          position: fixed;
          right: 20px;
          bottom: 70px;
          width: 380px;
          max-width: calc(100vw - 24px);
          background: #fff;
          color: #222;
          border: 1px solid #cfcfcf;
          border-radius: 12px;
          box-shadow: 0 12px 32px rgba(0,0,0,.25);
          z-index: 999999;
          overflow: hidden;
          font: 14px/1.4 Arial, sans-serif;
        }

        #${ID_PREFIX}-panel.hidden {
          display: none;
        }

        #${ID_PREFIX}-panel.minimized .${ID_PREFIX}-body {
          display: none;
        }

        .${ID_PREFIX}-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          background: #0b5ed7;
          color: #fff;
          padding: 10px 12px;
        }

        .${ID_PREFIX}-title {
          font-weight: 700;
        }

        .${ID_PREFIX}-header-actions {
          display: flex;
          gap: 6px;
        }

        .${ID_PREFIX}-icon-btn {
          border: none;
          background: rgba(255,255,255,.18);
          color: #fff;
          width: 28px;
          height: 28px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 700;
        }

        .${ID_PREFIX}-body {
          padding: 12px;
        }

        .${ID_PREFIX}-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin-bottom: 12px;
        }

        .${ID_PREFIX}-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .${ID_PREFIX}-field label {
          font-size: 12px;
          font-weight: 700;
          color: #555;
        }

        .${ID_PREFIX}-field input {
          padding: 8px 10px;
          border: 1px solid #cfcfcf;
          border-radius: 8px;
          font-size: 14px;
        }

        .${ID_PREFIX}-controls {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 12px;
        }

        .${ID_PREFIX}-btn {
          border: none;
          border-radius: 8px;
          padding: 9px 12px;
          cursor: pointer;
          font-weight: 700;
          font-size: 13px;
        }

        .${ID_PREFIX}-btn.primary {
          background: #198754;
          color: #fff;
        }

        .${ID_PREFIX}-btn.warning {
          background: #fd7e14;
          color: #fff;
        }

        .${ID_PREFIX}-btn.danger {
          background: #dc3545;
          color: #fff;
        }

        .${ID_PREFIX}-btn.secondary {
          background: #6c757d;
          color: #fff;
        }

        .${ID_PREFIX}-btn:disabled {
          opacity: .6;
          cursor: not-allowed;
        }

        .${ID_PREFIX}-stats {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin-bottom: 12px;
          font-size: 12px;
        }

        .${ID_PREFIX}-stat {
          background: #f7f7f7;
          border: 1px solid #ececec;
          border-radius: 8px;
          padding: 8px;
        }

        .${ID_PREFIX}-log {
          height: 160px;
          overflow: auto;
          background: #111;
          color: #d6ffd6;
          border-radius: 8px;
          padding: 10px;
          font: 12px/1.45 Consolas, Monaco, monospace;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .${ID_PREFIX}-small {
          font-size: 12px;
          color: #666;
          margin-top: 8px;
        }
      `
    });

    document.head.appendChild(style);
  }

  function getUrlParam(name) {
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
  }

  function getTodayLocalYMD() {
    const now = new Date();
    const tzAdjusted = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return tzAdjusted.toISOString().slice(0, 10);
  }

  function parseYMDToUTC(ymd) {
    const [year, month, day] = ymd.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }

  function formatUTCDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDaysUTC(date, days) {
    const next = new Date(date.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sanitizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function buildDayUrl(ymd) {
    const url = new URL(window.location.href);
    url.searchParams.set('startDate', ymd);
    url.searchParams.set('endDate', ymd);

    if (!url.searchParams.has('criteria')) {
      url.searchParams.set('criteria', '4');
    }
    if (!url.searchParams.has('archive')) {
      url.searchParams.set('archive', 'news');
    }

    return url.toString();
  }

  async function fetchHtml(url) {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store'
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    return await res.text();
  }

  function parseHeadlineRange(doc) {
    const headline = sanitizeText($('.BodyHead.topBodyHead', doc)?.textContent || '');
    const match = headline.match(/News from:\s*(\d{4}-\d{2}-\d{2})\s*To:\s*(\d{4}-\d{2}-\d{2})/i);
    return {
      headline,
      rangeFrom: match ? match[1] : '',
      rangeTo: match ? match[2] : ''
    };
  }

  function pageHasNoNews(doc) {
    const textCenter = Array.from(doc.querySelectorAll('.table-news .text-center'))
      .map((el) => sanitizeText(el.textContent))
      .join(' | ')
      .toLowerCase();

    return textCenter.includes('no new news found');
  }

  function pushCurrentRecord(out, current, meta) {
    if (!current || (!current.trading_code && !current.news_title && !current.news && !current.post_date)) {
      return;
    }

    out.push({
      search_date: meta.searchDate,
      range_from: meta.rangeFrom || meta.searchDate,
      range_to: meta.rangeTo || meta.searchDate,
      trading_code: current.trading_code || '',
      news_title: current.news_title || '',
      news: current.news || '',
      post_date: current.post_date || '',
      page_url: meta.pageUrl
    });
  }

  function parseNewsRows(doc, pageUrl, searchDate) {
    const { rangeFrom, rangeTo } = parseHeadlineRange(doc);

    if (pageHasNoNews(doc)) {
      return [];
    }

    const rows = Array.from(doc.querySelectorAll('.table-news tr'));
    const parsed = [];
    let current = {};

    for (const row of rows) {
      const hasHr = !!row.querySelector('hr');
      const th = row.querySelector('th');
      const td = row.querySelector('td');

      if (hasHr) {
        pushCurrentRecord(parsed, current, { pageUrl, searchDate, rangeFrom, rangeTo });
        current = {};
        continue;
      }

      if (!th || !td) {
        continue;
      }

      const rawLabel = sanitizeText(th.textContent).replace(/:$/, '');
      const value = sanitizeText(td.textContent);

      if (!rawLabel && !value) {
        continue;
      }

      switch (rawLabel.toLowerCase()) {
        case 'trading code':
          if (current.trading_code || current.news_title || current.news || current.post_date) {
            pushCurrentRecord(parsed, current, { pageUrl, searchDate, rangeFrom, rangeTo });
            current = {};
          }
          current.trading_code = value;
          break;
        case 'news title':
          current.news_title = value;
          break;
        case 'news':
          current.news = value;
          break;
        case 'post date':
          current.post_date = value;
          break;
        default:
          // ignore other labels
          break;
      }
    }

    pushCurrentRecord(parsed, current, { pageUrl, searchDate, rangeFrom, rangeTo });

    return parsed;
  }

  function toCsv(rows) {
    const headers = [
      'search_date',
      'range_from',
      'range_to',
      'trading_code',
      'news_title',
      'news',
      'post_date',
      'page_url'
    ];

    const escapeCsv = (value) => {
      const s = String(value ?? '');
      return `"${s.replace(/"/g, '""')}"`;
    };

    const lines = [
      headers.join(','),
      ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(','))
    ];

    return '\uFEFF' + lines.join('\n');
  }

  function downloadCsv(rows, startDate, endDate) {
    if (!rows.length) {
      alert('No results available to download.');
      return;
    }

    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `dse_old_news_${startDate}_to_${endDate}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function buildUi() {
    injectStyles();

    if (document.getElementById(`${ID_PREFIX}-fab`)) return;

    const defaultStart = getUrlParam('startDate') || getTodayLocalYMD();
    const defaultEnd = getTodayLocalYMD();

    const fab = createEl('button', {
      id: `${ID_PREFIX}-fab`,
      textContent: 'scraper',
      title: 'Open scraper widget'
    });

    const panel = createEl('div', {
      id: `${ID_PREFIX}-panel`,
      className: 'hidden'
    });

    panel.innerHTML = `
      <div class="${ID_PREFIX}-header">
        <div class="${ID_PREFIX}-title">DSE News Scraper</div>
        <div class="${ID_PREFIX}-header-actions">
          <button class="${ID_PREFIX}-icon-btn" data-action="minimize" title="Minimize">_</button>
          <button class="${ID_PREFIX}-icon-btn" data-action="close" title="Close">×</button>
        </div>
      </div>
      <div class="${ID_PREFIX}-body">
        <div class="${ID_PREFIX}-grid">
          <div class="${ID_PREFIX}-field">
            <label for="${ID_PREFIX}-start">Start date</label>
            <input id="${ID_PREFIX}-start" type="date" value="${defaultStart}">
          </div>
          <div class="${ID_PREFIX}-field">
            <label for="${ID_PREFIX}-end">End date</label>
            <input id="${ID_PREFIX}-end" type="date" value="${defaultEnd}">
          </div>
        </div>

        <div class="${ID_PREFIX}-controls">
          <button class="${ID_PREFIX}-btn primary" id="${ID_PREFIX}-start-btn">Start scraping</button>
          <button class="${ID_PREFIX}-btn warning" id="${ID_PREFIX}-pause-btn" disabled>Pause</button>
          <button class="${ID_PREFIX}-btn danger" id="${ID_PREFIX}-stop-btn" disabled>Stop</button>
          <button class="${ID_PREFIX}-btn secondary" id="${ID_PREFIX}-download-btn">Download CSV</button>
        </div>

        <div class="${ID_PREFIX}-stats">
          <div class="${ID_PREFIX}-stat"><strong>Status:</strong> <span id="${ID_PREFIX}-status">Idle</span></div>
          <div class="${ID_PREFIX}-stat"><strong>Rows:</strong> <span id="${ID_PREFIX}-rows">0</span></div>
          <div class="${ID_PREFIX}-stat"><strong>Current date:</strong> <span id="${ID_PREFIX}-current-date">-</span></div>
          <div class="${ID_PREFIX}-stat"><strong>Skipped dates:</strong> <span id="${ID_PREFIX}-skipped">0</span></div>
        </div>

        <div id="${ID_PREFIX}-log" class="${ID_PREFIX}-log"></div>
        <div class="${ID_PREFIX}-small">The script scrapes one day at a time using startDate=endDate for each request.</div>
      </div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    const startInput = document.getElementById(`${ID_PREFIX}-start`);
    const endInput = document.getElementById(`${ID_PREFIX}-end`);
    const startBtn = document.getElementById(`${ID_PREFIX}-start-btn`);
    const pauseBtn = document.getElementById(`${ID_PREFIX}-pause-btn`);
    const stopBtn = document.getElementById(`${ID_PREFIX}-stop-btn`);
    const downloadBtn = document.getElementById(`${ID_PREFIX}-download-btn`);
    const statusEl = document.getElementById(`${ID_PREFIX}-status`);
    const rowsEl = document.getElementById(`${ID_PREFIX}-rows`);
    const currentDateEl = document.getElementById(`${ID_PREFIX}-current-date`);
    const skippedEl = document.getElementById(`${ID_PREFIX}-skipped`);
    const logEl = document.getElementById(`${ID_PREFIX}-log`);

    let skippedDates = 0;

    function log(message) {
      const now = new Date();
      const stamp = now.toLocaleTimeString();
      logEl.textContent += `[${stamp}] ${message}\n`;
      logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(text) {
      statusEl.textContent = text;
    }

    function setRunningState(running) {
      startBtn.disabled = running;
      pauseBtn.disabled = !running;
      stopBtn.disabled = !running;
      startInput.disabled = running;
      endInput.disabled = running;
    }

    async function scrapeRange(startDateStr, endDateStr) {
      results = [];
      skippedDates = 0;
      rowsEl.textContent = '0';
      skippedEl.textContent = '0';
      logEl.textContent = '';

      const startDate = parseYMDToUTC(startDateStr);
      const endDate = parseYMDToUTC(endDateStr);

      isRunning = true;
      isPaused = false;
      stopRequested = false;
      setRunningState(true);
      pauseBtn.textContent = 'Pause';
      setStatus('Running');
      log(`Starting scrape from ${startDateStr} to ${endDateStr}`);

      let current = startDate;

      while (current.getTime() <= endDate.getTime()) {
        if (stopRequested) {
          log('Stop requested. Ending scrape.');
          break;
        }

        while (isPaused && !stopRequested) {
          setStatus('Paused');
          await sleep(300);
        }

        if (stopRequested) {
          log('Stop requested while paused. Ending scrape.');
          break;
        }

        const ymd = formatUTCDate(current);
        const url = buildDayUrl(ymd);

        currentDateEl.textContent = ymd;
        setStatus(`Scraping ${ymd}`);
        log(`Fetching ${url}`);

        try {
          // Keeps the address bar aligned with the current scraped date without reloading the page
          history.replaceState(null, '', url);

          const html = await fetchHtml(url);
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const rows = parseNewsRows(doc, url, ymd);

          if (!rows.length) {
            skippedDates += 1;
            skippedEl.textContent = String(skippedDates);
            log(`No news found for ${ymd}. Skipped.`);
          } else {
            results.push(...rows);
            rowsEl.textContent = String(results.length);
            log(`Saved ${rows.length} row(s) for ${ymd}. Total rows: ${results.length}`);
          }
        } catch (error) {
          log(`Error on ${ymd}: ${error.message || error}`);
        }

        current = addDaysUTC(current, 1);

        if (current.getTime() <= endDate.getTime() && !stopRequested) {
          await sleep(REQUEST_DELAY_MS);
        }
      }

      isRunning = false;
      isPaused = false;
      setRunningState(false);
      setStatus(stopRequested ? 'Stopped' : 'Completed');
      pauseBtn.textContent = 'Pause';
      log(`Done. Final row count: ${results.length}`);
    }

    fab.addEventListener('click', () => {
      panel.classList.remove('hidden');
      panel.classList.remove('minimized');
    });

    panel.addEventListener('click', (event) => {
      const action = event.target?.dataset?.action;
      if (!action) return;

      if (action === 'close') {
        panel.classList.add('hidden');
      } else if (action === 'minimize') {
        panel.classList.toggle('minimized');
      }
    });

    startBtn.addEventListener('click', async () => {
      const startDate = startInput.value;
      const endDate = endInput.value;

      if (!startDate || !endDate) {
        alert('Please select both start date and end date.');
        return;
      }

      if (parseYMDToUTC(startDate).getTime() > parseYMDToUTC(endDate).getTime()) {
        alert('Start date cannot be after end date.');
        return;
      }

      await scrapeRange(startDate, endDate);
    });

    pauseBtn.addEventListener('click', () => {
      if (!isRunning) return;

      isPaused = !isPaused;
      pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
      setStatus(isPaused ? 'Paused' : 'Running');
      log(isPaused ? 'Paused by user.' : 'Resumed by user.');
    });

    stopBtn.addEventListener('click', () => {
      if (!isRunning) return;

      stopRequested = true;
      isPaused = false;
      pauseBtn.textContent = 'Pause';
      setStatus('Stopping...');
      log('Stop requested by user.');
    });

    downloadBtn.addEventListener('click', () => {
      downloadCsv(results, startInput.value || 'start', endInput.value || 'end');
    });
  }

  buildUi();
})();
