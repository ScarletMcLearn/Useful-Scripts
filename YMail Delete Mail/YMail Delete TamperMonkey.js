// ==UserScript==
// @name         YouTube Reload if Real Title Missing (2025 Fix)
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Hard reload YouTube video page if the actual video title doesn't show up (2025 selector fix) 🎯📺🔁
// @author       You
// @match        https://www.youtube.com/watch*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let hasReloaded = false;

    function getTitleElement() {
        return document.querySelector('ytd-watch-metadata yt-formatted-string[title]');
    }

    function isTitleLoaded() {
        const el = getTitleElement();
        return el && el.textContent.trim().length > 0;
    }


     // 10000

    function waitForTitleOrReload(timeoutMs = 5000) {
        const startTime = Date.now();
        const observer = new MutationObserver(() => {
            if (isTitleLoaded()) {
                observer.disconnect();
                clearInterval(pollInterval);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        const pollInterval = setInterval(() => {
            if (isTitleLoaded()) {
                observer.disconnect();
                clearInterval(pollInterval);
            } else if (Date.now() - startTime >= timeoutMs && !hasReloaded) {
                hasReloaded = true;
                console.warn("🔁 YouTube title still missing. Reloading hard...");
                observer.disconnect();
                clearInterval(pollInterval);
                window.location.replace(window.location.href); // hard reload
            }
        }, 500);
    }

    function monitorUrlChanges() {
        let lastUrl = location.href;

        new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                hasReloaded = false;
                if (location.href.includes("/watch")) {
                    waitForTitleOrReload();
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

    // Initial run
    if (location.href.includes("/watch")) {
        waitForTitleOrReload();
    }

    // SPA page navigation support
    monitorUrlChanges();
})();
