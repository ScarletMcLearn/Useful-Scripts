// ==UserScript==
// @name         GitHub Profile Auto Reloader (ScarletMcLearn)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Adds a Start/Stop button on your GitHub profile to auto-reload with random intervals.
// @author       You
// @match        https://github.com/ScarletMcLearn
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_ACTIVE_KEY = 'smc_autoReloadActive';
    const STORAGE_COUNTER_KEY = 'smc_autoReloadCounter';

    let reloadTimerId = null;

    function getActive() {
        return GM_getValue(STORAGE_ACTIVE_KEY, false);
    }

    function setActive(val) {
        GM_setValue(STORAGE_ACTIVE_KEY, !!val);
    }

    function getCounter() {
        return GM_getValue(STORAGE_COUNTER_KEY, 0);
    }

    function setCounter(val) {
        GM_setValue(STORAGE_COUNTER_KEY, Number(val) || 0);
    }

    function scheduleReload() {
        const minSeconds = 5;
        const maxSeconds = 10;
        const delaySeconds = minSeconds + Math.random() * (maxSeconds - minSeconds);
        const delayMs = delaySeconds * 1000;

        clearTimeout(reloadTimerId);
        reloadTimerId = setTimeout(() => {
            window.location.reload();
        }, delayMs);
    }

    function updateButtonLabel(btn) {
        const active = getActive();
        const counter = getCounter();

        if (active) {
            btn.textContent = `Stop | Counter = ${counter}`;
            btn.style.backgroundColor = '#c93c3c'; // red-ish when active
        } else {
            btn.textContent = 'Start';
            btn.style.backgroundColor = '#238636'; // GitHub green-ish
        }
    }

    function onButtonClick() {
        const btn = document.getElementById('smc-auto-reload-btn');
        if (!btn) return;

        const active = getActive();

        if (!active) {
            // Starting
            setActive(true);
            setCounter(1); // first run -> Counter = 1
            updateButtonLabel(btn);
            scheduleReload();
        } else {
            // Stopping
            setActive(false);
            clearTimeout(reloadTimerId);
            updateButtonLabel(btn);
        }
    }

    function createButton() {
        let btn = document.getElementById('smc-auto-reload-btn');
        if (btn) return btn;

        btn = document.createElement('button');
        btn.id = 'smc-auto-reload-btn';
        btn.textContent = 'Start';

        Object.assign(btn.style, {
            position: 'fixed',
            right: '20px',
            bottom: '20px',
            padding: '10px 16px',
            backgroundColor: '#238636',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '14px',
            cursor: 'pointer',
            zIndex: '9999',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
        });

        btn.addEventListener('mouseenter', () => {
            btn.style.opacity = '0.9';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.opacity = '1';
        });

        btn.addEventListener('click', onButtonClick);

        document.body.appendChild(btn);
        return btn;
    }

    function init() {
        const btn = createButton();

        if (getActive()) {
            // We arrived here because auto-reload is active
            let current = getCounter();
            if (current > 0) {
                setCounter(current + 1); // increment on each reload
            } else {
                setCounter(1); // safety fallback
            }
            updateButtonLabel(btn);
            scheduleReload();
        } else {
            updateButtonLabel(btn);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
