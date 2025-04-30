// ==UserScript==
// @name         YouTube Reload Once Per Real Video Change (Force Scroll to Top 2025)
// @namespace    http://tampermonkey.net/
// @version      7.2
// @description  Reload YouTube video once per real video load and force scrolling to top for a few seconds after load. 🔁📺🔝✅
// @author       You
// @match        https://www.youtube.com/watch*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const RELOAD_MARKER_PREFIX = 'yt-reloaded-once-v7-';
    let lastVideoId = null;

    function getVideoId() {
        return new URLSearchParams(location.search).get('v');
    }

    function hasReloaded(videoId) {
        return localStorage.getItem(RELOAD_MARKER_PREFIX + videoId) === 'true';
    }

    function markReloaded(videoId) {
        localStorage.setItem(RELOAD_MARKER_PREFIX + videoId, 'true');
    }

    function tryReload() {
        const videoId = getVideoId();
        if (!videoId) return;

        if (videoId !== lastVideoId) {
            console.log(`[YouTube Reload] 🎯 New video detected: ${lastVideoId} → ${videoId}`);
            lastVideoId = videoId;

            if (!hasReloaded(videoId)) {
                if (document.visibilityState === 'visible') {
                    console.warn(`[YouTube Reload] 🔁 Reloading for video ID: ${videoId}`);
                    markReloaded(videoId);
                    window.location.reload();
                } else {
                    console.log(`[YouTube Reload] 🚫 Tab not visible, waiting...`);
                    document.addEventListener('visibilitychange', function onVisible() {
                        if (document.visibilityState === 'visible') {
                            document.removeEventListener('visibilitychange', onVisible);
                            console.warn(`[YouTube Reload] 🔁 Reloading after tab became visible`);
                            markReloaded(videoId);
                            window.location.reload();
                        }
                    });
                }
            } else {
                console.log(`[YouTube Reload] ✅ Already reloaded for video ID: ${videoId}`);
            }
        }
    }

    function setupNavigationListener() {
        window.addEventListener('yt-navigate-finish', () => {
            console.log(`[YouTube Reload] 📢 yt-navigate-finish detected`);
            tryReload();
        });
    }

    function forceScrollTop() {
        window.addEventListener('load', () => {
            console.log(`[YouTube Reload] 🔝 Starting force scroll to top`);
            const start = Date.now();
            const interval = setInterval(() => {
                window.scrollTo(0, 0);

                if (Date.now() - start > 3000) { // 3 seconds
                    clearInterval(interval);
                    console.log(`[YouTube Reload] 🛑 Stopped force scroll to top`);
                }
            }, 100); // scroll every 100ms
        });
    }

    // --- MAIN ---
    lastVideoId = getVideoId();
    tryReload();
    setupNavigationListener();
    forceScrollTop();
})();
