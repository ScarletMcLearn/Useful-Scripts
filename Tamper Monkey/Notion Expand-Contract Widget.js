// ==UserScript==
// @name         Notion Expand / Contract Widget
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Expand or contract Notion toggle blocks from a bottom-right widget
// @match        https://www.notion.so/*
// @match        https://*.notion.so/*
// @match        https://*.notion.site/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    const ROOT_ID = "tm-notion-toggle-widget-root";
    const OPEN_BTN_ID = "tm-notion-toggle-widget-open";
    const STORAGE_KEY_MINIMIZED = "tmNotionWidgetMinimized";
    const STORAGE_KEY_HIDDEN = "tmNotionWidgetHidden";

    let rootEl = null;
    let openBtnEl = null;
    let headerRowEl = null;
    let contentWrapEl = null;
    let modeLabelEl = null;
    let modeToggleEl = null;
    let startBtnEl = null;
    let observer = null;
    let isRunning = false;
    let isMinimized = false;
    let isHidden = false;

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function isNotionPage() {
        const host = location.hostname;
        return (
            host === "www.notion.so" ||
            host.endsWith(".notion.so") ||
            host.endsWith(".notion.site")
        );
    }

    function isVisible(el) {
        if (!el || !document.contains(el)) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            rect.width > 6 &&
            rect.height > 6
        );
    }

    function getMainRoot() {
        return (
            document.querySelector('[role="main"]') ||
            document.querySelector("main") ||
            document.body
        );
    }

    function isInChrome(el) {
        return !!el.closest(
            'nav, aside, [role="navigation"], [role="menu"], [role="dialog"], [data-overlay="true"]'
        );
    }

    function getMode() {
        return modeToggleEl?.checked ? "expand" : "contract";
    }

    function getCurrentStateValue() {
        return getMode() === "expand" ? "false" : "true";
    }

    function getTargetStateValue() {
        return getMode() === "expand" ? "true" : "false";
    }

    function getModeText() {
        return getMode() === "expand" ? "Expand" : "Contract";
    }

    function loadUiState() {
        try {
            isMinimized = localStorage.getItem(STORAGE_KEY_MINIMIZED) === "1";
            isHidden = localStorage.getItem(STORAGE_KEY_HIDDEN) === "1";
        } catch (_) {
            isMinimized = false;
            isHidden = false;
        }
    }

    function saveUiState() {
        try {
            localStorage.setItem(STORAGE_KEY_MINIMIZED, isMinimized ? "1" : "0");
            localStorage.setItem(STORAGE_KEY_HIDDEN, isHidden ? "1" : "0");
        } catch (_) {}
    }

    function updateModeLabel() {
        if (modeLabelEl) {
            modeLabelEl.textContent = getModeText();
        }
    }

    function getCandidatesByState(stateValue) {
        const root = getMainRoot();
        const raw = [
            ...root.querySelectorAll(`[aria-expanded="${stateValue}"]`),
            ...root.querySelectorAll(`button[aria-expanded="${stateValue}"]`),
            ...root.querySelectorAll(`[role="button"][aria-expanded="${stateValue}"]`)
        ];

        const seen = new Set();
        const result = [];

        for (const el of raw) {
            if (!el || seen.has(el)) continue;
            seen.add(el);

            if (!isVisible(el)) continue;
            if (isInChrome(el)) continue;
            if (rootEl && rootEl.contains(el)) continue;
            if (openBtnEl && openBtnEl.contains(el)) continue;

            const rect = el.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) continue;
            if (rect.left < 120) continue;

            result.push(el);
        }

        result.sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();

            if (getMode() === "expand") {
                if (Math.abs(ra.top - rb.top) > 2) return ra.top - rb.top;
                return ra.left - rb.left;
            }

            if (Math.abs(ra.top - rb.top) > 2) return rb.top - ra.top;
            return rb.left - ra.left;
        });

        return result;
    }

    function getActionableCandidates() {
        return getCandidatesByState(getCurrentStateValue());
    }

    function dispatchClickSequence(target) {
        if (!target || !document.contains(target)) return;

        const rect = target.getBoundingClientRect();
        const x = Math.floor(rect.left + Math.max(8, Math.min(18, rect.width / 2)));
        const y = Math.floor(rect.top + rect.height / 2);

        const hit = document.elementFromPoint(x, y) || target;
        const actual =
            hit.closest?.('button,[role="button"],[aria-expanded]') ||
            target.closest?.('button,[role="button"],[aria-expanded]') ||
            hit ||
            target;

        const mouseOpts = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y
        };

        try { actual.dispatchEvent(new PointerEvent("pointerdown", mouseOpts)); } catch (_) {}
        try { actual.dispatchEvent(new MouseEvent("mousedown", mouseOpts)); } catch (_) {}
        try { actual.dispatchEvent(new PointerEvent("pointerup", mouseOpts)); } catch (_) {}
        try { actual.dispatchEvent(new MouseEvent("mouseup", mouseOpts)); } catch (_) {}
        try { actual.dispatchEvent(new MouseEvent("click", mouseOpts)); } catch (_) {}
        try { actual.click(); } catch (_) {}
    }

    function getClickTargets(el) {
        const out = [];

        const add = (node) => {
            if (!node) return;
            if (!document.contains(node)) return;
            if (!isVisible(node)) return;
            if (!out.includes(node)) out.push(node);
        };

        add(el);
        add(el.closest('[aria-expanded],button,[role="button"]'));
        add(el.querySelector?.('[aria-expanded],button,[role="button"]'));

        const svg = el.querySelector?.("svg");
        if (svg) {
            add(svg);
            add(svg.parentElement);
            add(svg.closest?.('[aria-expanded],button,[role="button"],div'));
        }

        let p = el.parentElement;
        for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
            if (isInChrome(p)) break;
            if (
                p.matches?.('[aria-expanded],button,[role="button"]') ||
                p.tabIndex >= 0 ||
                p.querySelector?.("svg")
            ) {
                add(p);
            }
        }

        return out;
    }

    async function tryToggleItem(el) {
        if (!el || !document.contains(el)) return false;

        const before = el.getAttribute("aria-expanded");
        const targetState = getTargetStateValue();
        if (before !== getCurrentStateValue()) return false;

        const rect = el.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
            try {
                el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
            } catch (_) {
                el.scrollIntoView({ block: "center", inline: "nearest" });
            }
            await wait(120);
        }

        const targets = getClickTargets(el);

        for (const target of targets) {
            dispatchClickSequence(target);
            await wait(180);

            if (!document.contains(el)) return true;
            if (el.getAttribute("aria-expanded") === targetState) return true;
        }

        for (const target of targets) {
            try { target.focus(); } catch (_) {}

            for (const key of ["Enter", " "]) {
                try {
                    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
                    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
                } catch (_) {}

                await wait(150);

                if (!document.contains(el)) return true;
                if (el.getAttribute("aria-expanded") === targetState) return true;
            }
        }

        return false;
    }

    function setStartButtonText(text) {
        if (startBtnEl) startBtnEl.textContent = text;
    }

    async function runAction() {
        if (isRunning) return;
        isRunning = true;

        try {
            const actionText = getModeText();
            let totalChanged = 0;
            let stalePasses = 0;

            for (let pass = 0; pass < 20; pass++) {
                const items = getActionableCandidates();
                if (items.length === 0) break;

                setStartButtonText(`${actionText}ing (${items.length})`);

                let changedThisPass = 0;

                for (const item of items) {
                    const ok = await tryToggleItem(item);
                    if (ok) {
                        totalChanged++;
                        changedThisPass++;
                    }
                    await wait(80);
                }

                if (changedThisPass === 0) {
                    stalePasses++;
                } else {
                    stalePasses = 0;
                }

                if (stalePasses >= 2) break;
                await wait(250);
            }

            setStartButtonText(
                totalChanged > 0 ? `${getModeText()}ed ${totalChanged}` : `No ${getModeText().toLowerCase()} items`
            );
            await wait(900);
        } finally {
            isRunning = false;
            setStartButtonText("Start");
            updateWidgetVisibility();
        }
    }

    function buildSwitch() {
        const wrap = document.createElement("label");
        Object.assign(wrap.style, {
            position: "relative",
            display: "inline-block",
            width: "42px",
            height: "24px",
            cursor: "pointer",
            flexShrink: "0"
        });

        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = true;
        Object.assign(input.style, {
            opacity: "0",
            width: "0",
            height: "0",
            position: "absolute"
        });

        const slider = document.createElement("span");
        Object.assign(slider.style, {
            position: "absolute",
            inset: "0",
            background: "#3b82f6",
            borderRadius: "999px",
            transition: "0.2s"
        });

        const knob = document.createElement("span");
        Object.assign(knob.style, {
            position: "absolute",
            height: "18px",
            width: "18px",
            left: "3px",
            top: "3px",
            background: "#fff",
            borderRadius: "50%",
            transition: "0.2s",
            boxShadow: "0 1px 4px rgba(0,0,0,0.25)"
        });

        slider.appendChild(knob);
        wrap.appendChild(input);
        wrap.appendChild(slider);

        input.addEventListener("change", () => {
            slider.style.background = input.checked ? "#3b82f6" : "#555";
            knob.style.transform = input.checked ? "translateX(18px)" : "translateX(0)";
            updateModeLabel();
            updateWidgetVisibility();
        });

        knob.style.transform = "translateX(18px)";

        return { wrap, input };
    }

    function makeIconButton(label, title) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.title = title;
        Object.assign(btn.style, {
            border: "none",
            background: "transparent",
            color: "#fff",
            cursor: "pointer",
            fontSize: "16px",
            lineHeight: "1",
            padding: "2px 6px",
            borderRadius: "6px",
            opacity: "0.9"
        });

        btn.addEventListener("mouseenter", () => {
            btn.style.background = "rgba(255,255,255,0.12)";
        });

        btn.addEventListener("mouseleave", () => {
            btn.style.background = "transparent";
        });

        return btn;
    }

    function minimizeWidget() {
        isMinimized = true;
        isHidden = false;
        saveUiState();
        applyWidgetState();
    }

    function expandWidget() {
        isMinimized = false;
        isHidden = false;
        saveUiState();
        applyWidgetState();
    }

    function hideWidget() {
        isHidden = true;
        isMinimized = false;
        saveUiState();
        applyWidgetState();
    }

    function showWidget() {
        isHidden = false;
        isMinimized = false;
        saveUiState();
        applyWidgetState();
    }

    function applyWidgetState() {
        if (!rootEl || !openBtnEl || !contentWrapEl) return;

        if (isHidden) {
            rootEl.style.display = "none";
            openBtnEl.style.display = "block";
            return;
        }

        openBtnEl.style.display = "none";
        rootEl.style.display = "block";

        if (isMinimized) {
            contentWrapEl.style.display = "none";
            rootEl.style.minWidth = "auto";
            rootEl.style.padding = "10px 12px";
        } else {
            contentWrapEl.style.display = "block";
            rootEl.style.minWidth = "220px";
            rootEl.style.padding = "12px";
        }
    }

    function createOpenButton() {
        const existing = document.getElementById(OPEN_BTN_ID);
        if (existing) {
            openBtnEl = existing;
            return;
        }

        openBtnEl = document.createElement("button");
        openBtnEl.id = OPEN_BTN_ID;
        openBtnEl.textContent = "Open";
        Object.assign(openBtnEl.style, {
            position: "fixed",
            right: "20px",
            bottom: "20px",
            zIndex: "2147483647",
            border: "none",
            borderRadius: "999px",
            padding: "10px 14px",
            background: "rgba(17,17,17,0.96)",
            color: "#fff",
            cursor: "pointer",
            boxShadow: "0 6px 18px rgba(0,0,0,0.28)",
            fontFamily: "Inter, Arial, sans-serif",
            fontSize: "14px",
            fontWeight: "600",
            display: "none"
        });

        openBtnEl.addEventListener("click", showWidget);
        document.body.appendChild(openBtnEl);
    }

    function createWidget() {
        const existing = document.getElementById(ROOT_ID);
        if (existing) {
            rootEl = existing;
            modeLabelEl = rootEl.querySelector('[data-role="mode-label"]');
            modeToggleEl = rootEl.querySelector('[data-role="mode-toggle"]');
            startBtnEl = rootEl.querySelector('[data-role="start-btn"]');
            headerRowEl = rootEl.querySelector('[data-role="header-row"]');
            contentWrapEl = rootEl.querySelector('[data-role="content-wrap"]');
            return;
        }

        rootEl = document.createElement("div");
        rootEl.id = ROOT_ID;

        Object.assign(rootEl.style, {
            position: "fixed",
            right: "20px",
            bottom: "20px",
            zIndex: "2147483647",
            minWidth: "220px",
            background: "rgba(17,17,17,0.96)",
            color: "#fff",
            borderRadius: "12px",
            padding: "12px",
            boxShadow: "0 6px 18px rgba(0,0,0,0.28)",
            fontFamily: "Inter, Arial, sans-serif",
            fontSize: "14px",
            display: "none",
            userSelect: "none"
        });

        headerRowEl = document.createElement("div");
        headerRowEl.setAttribute("data-role", "header-row");
        Object.assign(headerRowEl.style, {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px"
        });

        const titleEl = document.createElement("div");
        titleEl.textContent = "Notion Toggle";
        Object.assign(titleEl.style, {
            fontWeight: "700",
            fontSize: "14px"
        });

        const actionsEl = document.createElement("div");
        Object.assign(actionsEl.style, {
            display: "flex",
            alignItems: "center",
            gap: "4px"
        });

        const minimizeBtn = makeIconButton("–", "Minimize");
        const hideBtn = makeIconButton("×", "Hide");
        const restoreBtn = makeIconButton("□", "Expand widget");

        minimizeBtn.addEventListener("click", () => {
            if (isMinimized) {
                expandWidget();
            } else {
                minimizeWidget();
            }
        });

        restoreBtn.addEventListener("click", expandWidget);
        hideBtn.addEventListener("click", hideWidget);

        actionsEl.appendChild(minimizeBtn);
        actionsEl.appendChild(restoreBtn);
        actionsEl.appendChild(hideBtn);

        headerRowEl.appendChild(titleEl);
        headerRowEl.appendChild(actionsEl);

        contentWrapEl = document.createElement("div");
        contentWrapEl.setAttribute("data-role", "content-wrap");
        Object.assign(contentWrapEl.style, {
            marginTop: "10px"
        });

        const topRow = document.createElement("div");
        Object.assign(topRow.style, {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            marginBottom: "10px"
        });

        modeLabelEl = document.createElement("div");
        modeLabelEl.setAttribute("data-role", "mode-label");
        modeLabelEl.textContent = "Expand";
        Object.assign(modeLabelEl.style, {
            fontWeight: "600",
            fontSize: "14px"
        });

        const switchParts = buildSwitch();
        modeToggleEl = switchParts.input;
        modeToggleEl.setAttribute("data-role", "mode-toggle");

        topRow.appendChild(modeLabelEl);
        topRow.appendChild(switchParts.wrap);

        startBtnEl = document.createElement("button");
        startBtnEl.setAttribute("data-role", "start-btn");
        startBtnEl.textContent = "Start";
        Object.assign(startBtnEl.style, {
            width: "100%",
            border: "none",
            borderRadius: "10px",
            padding: "10px 12px",
            fontSize: "14px",
            fontWeight: "600",
            cursor: "pointer",
            background: "#2563eb",
            color: "#fff"
        });

        startBtnEl.addEventListener("mouseenter", () => {
            if (!isRunning) startBtnEl.style.opacity = "0.92";
        });

        startBtnEl.addEventListener("mouseleave", () => {
            if (!isRunning) startBtnEl.style.opacity = "1";
        });

        startBtnEl.addEventListener("click", async () => {
            if (isRunning) return;
            await runAction();
        });

        contentWrapEl.appendChild(topRow);
        contentWrapEl.appendChild(startBtnEl);

        rootEl.appendChild(headerRowEl);
        rootEl.appendChild(contentWrapEl);
        document.body.appendChild(rootEl);
    }

    function updateWidgetVisibility() {
        if (!rootEl) return;

        const count = getActionableCandidates().length;
        const modeText = getModeText();

        if (modeLabelEl) {
            modeLabelEl.textContent = modeText;
        }

        if (!isRunning && startBtnEl) {
            startBtnEl.textContent = count > 0 ? `Start (${count})` : "Start";
            startBtnEl.disabled = false;
            startBtnEl.style.cursor = "pointer";
            startBtnEl.style.opacity = "1";
        }

        applyWidgetState();
    }

    function initObserver() {
        if (observer) observer.disconnect();

        let scheduled = false;
        observer = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;

            requestAnimationFrame(() => {
                scheduled = false;
                updateWidgetVisibility();
            });
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true
        });
    }

    function init() {
        if (!isNotionPage()) return;

        loadUiState();
        createOpenButton();
        createWidget();
        initObserver();

        setTimeout(updateWidgetVisibility, 500);
        setTimeout(updateWidgetVisibility, 1500);
        setTimeout(updateWidgetVisibility, 3000);

        window.addEventListener("load", updateWidgetVisibility);
        window.addEventListener("popstate", () => {
            setTimeout(updateWidgetVisibility, 500);
            setTimeout(updateWidgetVisibility, 1500);
        });

        setInterval(updateWidgetVisibility, 2000);
    }

    init();
})();
