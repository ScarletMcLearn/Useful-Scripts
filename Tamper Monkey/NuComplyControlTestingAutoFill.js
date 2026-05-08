// ==UserScript==
// @name         NuComply Control Testing Bulk Pass/Fail/Comment/Save Background Tolerant
// @namespace    nucomply-control-testing
// @version      2.5.1
// @description  Bulk select Pass, Fail, or Unselect. Add optional BD timestamp comment and save rows.
// @match        https://app.nucomply.com/compliance/control-testing/check-result*
// @match        https://app.nucomply.com/compliance/control-testing/run-details*
// @match        https://qa-app.nucomply.com/compliance/control-testing/check-result*
// @match        https://qa-app.nucomply.com/compliance/control-testing/run-details*
// @match        https://staging-app.nucomply.com/compliance/control-testing/check-result*
// @match        https://staging-app.nucomply.com/compliance/control-testing/run-details*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const SELECTED_CLASSES = new Set([
    "css-lnxdjs",  // Pass selected
    "css-1v3pzcx", // Fail selected
  ]);

  const UNSELECTED_CLASSES = new Set([
    "css-16oth2g",
  ]);

  // Bigger waits make background-tab execution more reliable.
  const CLICK_DELAY_MS = 600;
  const COMMENT_DELAY_MS = 900;
  const SAVE_DELAY_MS = 2200;
  const BETWEEN_ROWS_DELAY_MS = 900;

  let isRunning = false;
  let shouldStop = false;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function getText(element) {
    return normalizeText(element?.innerText || element?.textContent || "");
  }

  function isVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);

    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function visibleButtons(root = document) {
    return [...root.querySelectorAll("button")].filter(isVisible);
  }

  function findButton(root, text) {
    return visibleButtons(root).find((button) => getText(button) === text) || null;
  }

  function findButtonByTexts(root, texts) {
    return visibleButtons(root).find((button) => texts.includes(getText(button))) || null;
  }

  function hasAnyClass(element, classSet) {
    if (!element) return false;
    return [...element.classList].some((className) => classSet.has(className));
  }

  function isSelected(button) {
    if (!button) return false;

    const ariaPressed = button.getAttribute("aria-pressed");
    const ariaSelected = button.getAttribute("aria-selected");
    const dataState = button.getAttribute("data-state");

    if (ariaPressed === "true") return true;
    if (ariaSelected === "true") return true;

    if (
      dataState === "checked" ||
      dataState === "on" ||
      dataState === "active"
    ) {
      return true;
    }

    if (hasAnyClass(button, SELECTED_CLASSES)) return true;
    if (hasAnyClass(button, UNSELECTED_CLASSES)) return false;

    return false;
  }

  function isDisabled(button) {
    if (!button) return true;

    return (
      button.disabled ||
      button.getAttribute("aria-disabled") === "true" ||
      button.getAttribute("data-disabled") === "true"
    );
  }

  function getBDTimestamp() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Dhaka",
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).formatToParts(new Date());

    const get = (type) => parts.find((part) => part.type === type)?.value || "";

    return `${get("month")}-${get("day")}-${get("year")} ${get("hour")}:${get("minute")}:${get("second")} ${get("dayPeriod")}`;
  }

  function clickLikeUser(element) {
    if (!element) return;

    try {
      element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      element.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      element.click();
    } catch (error) {
      console.warn("[NuComply Bulk Result] clickLikeUser failed:", error);
      try {
        element.click();
      } catch (_) {}
    }
  }

  function setReactTextareaValue(textarea, value) {
    const prototype = Object.getPrototypeOf(textarea);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    const nativeSetter = descriptor?.set;

    const previousValue = textarea.value;

    if (nativeSetter) {
      nativeSetter.call(textarea, value);
    } else {
      textarea.value = value;
    }

    // Important for React controlled fields.
    const tracker = textarea._valueTracker;
    if (tracker) {
      tracker.setValue(previousValue);
    }

    textarea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value,
      })
    );

    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    textarea.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function findCardRootFromTextarea(textarea) {
    let current = textarea.parentElement;
    let fallback = null;

    for (let depth = 0; depth < 35 && current; depth++) {
      const passButton = findButton(current, "Pass");
      const failButton = findButton(current, "Fail");
      const textareas = [...current.querySelectorAll("textarea")];

      if (passButton && failButton && textareas.includes(textarea)) {
        if (!fallback) fallback = current;

        if (textareas.length === 1) {
          return current;
        }
      }

      current = current.parentElement;
    }

    return fallback;
  }

  function dedupeRoots(roots) {
    const unique = [];

    for (const root of roots) {
      if (!root) continue;
      if (!unique.includes(root)) unique.push(root);
    }

    return unique;
  }

  function getRowsFresh() {
    const textareas = [...document.querySelectorAll("textarea")]
      .filter(isVisible)
      .filter((textarea) => {
        const placeholder = textarea.getAttribute("placeholder") || "";
        const className = String(textarea.className || "");

        return (
          placeholder.toLowerCase().includes("add notes") ||
          className.includes("chakra-textarea")
        );
      });

    const roots = dedupeRoots(
      textareas.map((textarea) => findCardRootFromTextarea(textarea))
    );

    return roots
      .map((root, index) => {
        const passButton = findButton(root, "Pass");
        const failButton = findButton(root, "Fail");
        const saveButton = findButtonByTexts(root, ["Save", "Saved"]);
        const textarea = root.querySelector("textarea");

        return {
          index: index + 1,
          root,
          passButton,
          failButton,
          saveButton,
          textarea,
          passSelected: isSelected(passButton),
          failSelected: isSelected(failButton),
        };
      })
      .filter((row) => row.passButton && row.failButton && row.textarea);
  }

  function refreshRow(row) {
    row.passButton = findButton(row.root, "Pass");
    row.failButton = findButton(row.root, "Fail");
    row.saveButton = findButtonByTexts(row.root, ["Save", "Saved"]);
    row.textarea = row.root.querySelector("textarea");
    row.passSelected = isSelected(row.passButton);
    row.failSelected = isSelected(row.failButton);

    return row;
  }

  async function clickButton(button) {
    if (!button) return false;

    try {
      button.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
    } catch (_) {}

    await sleep(250);
    clickLikeUser(button);
    await sleep(CLICK_DELAY_MS);

    return true;
  }

  async function waitForSaveButton(row, timeoutMs = 12000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      row = refreshRow(row);

      const saveButton = findButton(row.root, "Save");

      if (
        saveButton &&
        document.contains(saveButton) &&
        isVisible(saveButton) &&
        !isDisabled(saveButton)
      ) {
        return saveButton;
      }

      await sleep(400);
    }

    return null;
  }

  async function addCommentToRow(row, rawComment) {
    const comment = normalizeText(rawComment);

    if (!comment) return false;

    row = refreshRow(row);

    if (!row.textarea) {
      console.warn("[NuComply Bulk Result] Comment textarea not found:", row);
      return false;
    }

    const timestamp = getBDTimestamp();
    const commentLine = `${timestamp} - ${comment}`;

    const existingValue = row.textarea.value || "";
    const nextValue = existingValue.trim()
      ? `${existingValue.trim()}\n${commentLine}`
      : commentLine;

    try {
      row.textarea.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
    } catch (_) {}

    await sleep(250);

    setReactTextareaValue(row.textarea, nextValue);
    await sleep(COMMENT_DELAY_MS);

    row = refreshRow(row);

    // Retry if React ignored first update.
    if (!row.textarea.value.includes(commentLine)) {
      setReactTextareaValue(row.textarea, nextValue);
      await sleep(COMMENT_DELAY_MS);
    }

    row = refreshRow(row);

    const success = row.textarea.value.includes(commentLine);

    if (!success) {
      console.warn("[NuComply Bulk Result] Failed to add comment:", {
        expected: commentLine,
        actual: row.textarea.value,
        row,
      });
    }

    return success;
  }

  async function saveRow(row) {
    row = refreshRow(row);

    let saveButton = await waitForSaveButton(row, 12000);

    // Fallback: sometimes the button still says Saved immediately after value update.
    if (!saveButton) {
      saveButton = findButtonByTexts(row.root, ["Save", "Saved"]);
    }

    if (!saveButton) {
      console.warn("[NuComply Bulk Result] Save/Saved button not found:", row);
      return false;
    }

    if (isDisabled(saveButton)) {
      console.warn("[NuComply Bulk Result] Save/Saved button disabled:", row);
      return false;
    }

    try {
      saveButton.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
    } catch (_) {}

    await sleep(300);
    clickLikeUser(saveButton);
    await sleep(SAVE_DELAY_MS);

    return true;
  }

  async function applyBulkAction(action, comment) {
    if (isRunning) {
      setStatus("Already running. Click Stop first if needed.");
      return;
    }

    isRunning = true;
    shouldStop = false;

    const rows = getRowsFresh();

    console.log("[NuComply Bulk Result] Detected rows:", rows);

    if (!rows.length) {
      setStatus("Detected 0 rows. Check console. Make sure result rows are loaded in the DOM.");
      isRunning = false;
      return;
    }

    let rowsToProcess = [];

    if (action === "pass") {
      rowsToProcess = rows.filter((row) => row.passButton);
    }

    if (action === "fail") {
      rowsToProcess = rows.filter((row) => row.failButton);
    }

    if (action === "unselect") {
      rowsToProcess = rows.filter(
        (row) => row.passSelected || row.failSelected
      );
    }

    setStatus(`Found ${rows.length} row(s). Processing ${rowsToProcess.length} row(s)...`);

    let changed = 0;
    let commented = 0;
    let saved = 0;
    let skipped = 0;

    for (let i = 0; i < rowsToProcess.length; i++) {
      if (shouldStop) {
        setStatus(
          `Stopped.\nProcessed: ${i}/${rowsToProcess.length}\nChanged: ${changed}\nCommented: ${commented}\nSaved clicked: ${saved}`
        );
        isRunning = false;
        return;
      }

      let row = rowsToProcess[i];

      try {
        row.root.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "instant",
        });
      } catch (_) {}

      await sleep(350);

      row = refreshRow(row);

      let rowChanged = false;

      if (action === "pass") {
        if (!row.passSelected) {
          await clickButton(row.passButton);
          rowChanged = true;
          await sleep(700);
        }
      }

      if (action === "fail") {
        if (!row.failSelected) {
          await clickButton(row.failButton);
          rowChanged = true;
          await sleep(700);
        }
      }

      if (action === "unselect") {
        if (row.passSelected) {
          await clickButton(row.passButton);
          rowChanged = true;
          await sleep(700);
        }

        row = refreshRow(row);

        if (row.failSelected) {
          await clickButton(row.failButton);
          rowChanged = true;
          await sleep(700);
        }
      }

      row = refreshRow(row);

      const commentAdded = await addCommentToRow(row, comment);

      if (rowChanged) changed++;
      if (commentAdded) commented++;

      if (rowChanged || commentAdded) {
        const didSave = await saveRow(row);
        if (didSave) saved++;
        else skipped++;
      } else {
        skipped++;
      }

      setStatus(
        `Running in background-tolerant mode...\nProcessed: ${i + 1}/${rowsToProcess.length}\nChanged: ${changed}\nCommented: ${commented}\nSaved clicked: ${saved}\nSkipped: ${skipped}`
      );

      await sleep(BETWEEN_ROWS_DELAY_MS);
    }

    isRunning = false;

    setStatus(
      `Done.\nRows found: ${rows.length}\nProcessed: ${rowsToProcess.length}\nChanged: ${changed}\nCommented: ${commented}\nSaved clicked: ${saved}\nSkipped: ${skipped}`
    );
  }

  function createWidget() {
    if (document.getElementById("nucomply-bulk-widget")) return;

    const wrapper = document.createElement("div");
    wrapper.id = "nucomply-bulk-widget";

    wrapper.innerHTML = `
      <style>
        #nucomply-bulk-widget {
          position: fixed;
          right: 18px;
          bottom: 18px;
          z-index: 999999;
          font-family: Arial, sans-serif;
        }

        #nucomply-bulk-widget * {
          box-sizing: border-box;
        }

        .ncb-collapsed {
          border: none;
          border-radius: 999px;
          padding: 12px 16px;
          background: #111827;
          color: #ffffff;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
          box-shadow: 0 8px 24px rgba(0,0,0,0.25);
        }

        .ncb-panel {
          display: none;
          width: 340px;
          padding: 14px;
          border-radius: 14px;
          background: #ffffff;
          color: #111827;
          box-shadow: 0 12px 32px rgba(0,0,0,0.28);
          border: 1px solid #e5e7eb;
        }

        .ncb-title {
          font-size: 15px;
          font-weight: 800;
          margin-bottom: 10px;
        }

        .ncb-note {
          font-size: 12px;
          color: #4b5563;
          margin-bottom: 10px;
          line-height: 1.35;
        }

        .ncb-options {
          display: grid;
          gap: 8px;
          margin-bottom: 12px;
        }

        .ncb-option {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
          cursor: pointer;
        }

        .ncb-comment-label {
          display: block;
          font-size: 13px;
          font-weight: 700;
          margin-bottom: 6px;
        }

        .ncb-comment {
          width: 100%;
          min-height: 76px;
          resize: vertical;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          padding: 8px;
          font-size: 13px;
          margin-bottom: 12px;
          color: #111827;
          background: #ffffff;
        }

        .ncb-actions {
          display: flex;
          gap: 8px;
        }

        .ncb-submit,
        .ncb-stop,
        .ncb-close {
          border: none;
          border-radius: 8px;
          padding: 9px 10px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }

        .ncb-submit {
          flex: 1;
          background: #2563eb;
          color: white;
        }

        .ncb-stop {
          background: #dc2626;
          color: white;
        }

        .ncb-close {
          background: #e5e7eb;
          color: #111827;
        }

        .ncb-submit:disabled {
          opacity: 0.7;
          cursor: not-allowed;
        }

        .ncb-status {
          margin-top: 10px;
          font-size: 12px;
          color: #374151;
          min-height: 18px;
          line-height: 1.35;
          white-space: pre-wrap;
        }
      </style>

      <button type="button" class="ncb-collapsed">Bulk Result</button>

      <div class="ncb-panel">
        <div class="ncb-title">Bulk Control Result</div>

        <div class="ncb-note">
          Background-tolerant mode: it will keep trying after tab/window switch, but browser throttling may make it slower.
        </div>

        <div class="ncb-options">
          <label class="ncb-option">
            <input type="radio" name="ncb-action" value="pass" checked />
            Pass all
          </label>

          <label class="ncb-option">
            <input type="radio" name="ncb-action" value="fail" />
            Fail all
          </label>

          <label class="ncb-option">
            <input type="radio" name="ncb-action" value="unselect" />
            Unselect selected
          </label>
        </div>

        <label class="ncb-comment-label" for="ncb-comment">
          Optional comment
        </label>

        <textarea
          id="ncb-comment"
          class="ncb-comment"
          placeholder="Comment will be added with BD timestamp to every processed row..."
        ></textarea>

        <div class="ncb-actions">
          <button type="button" class="ncb-submit">Submit</button>
          <button type="button" class="ncb-stop">Stop</button>
          <button type="button" class="ncb-close">Close</button>
        </div>

        <div class="ncb-status">Ready.</div>
      </div>
    `;

    document.body.appendChild(wrapper);

    const collapsedButton = wrapper.querySelector(".ncb-collapsed");
    const panel = wrapper.querySelector(".ncb-panel");
    const closeButton = wrapper.querySelector(".ncb-close");
    const stopButton = wrapper.querySelector(".ncb-stop");
    const submitButton = wrapper.querySelector(".ncb-submit");
    const commentBox = wrapper.querySelector(".ncb-comment");

    collapsedButton.addEventListener("click", () => {
      collapsedButton.style.display = "none";
      panel.style.display = "block";
      setStatus("Ready.");
    });

    closeButton.addEventListener("click", () => {
      panel.style.display = "none";
      collapsedButton.style.display = "block";
    });

    stopButton.addEventListener("click", () => {
      shouldStop = true;
      setStatus("Stopping after current row...");
    });

    submitButton.addEventListener("click", async () => {
      const selectedAction = wrapper.querySelector(
        'input[name="ncb-action"]:checked'
      )?.value;

      const comment = commentBox.value || "";

      submitButton.disabled = true;
      submitButton.textContent = "Working...";

      try {
        await applyBulkAction(selectedAction, comment);
      } catch (error) {
        console.error("[NuComply Bulk Result] Error:", error);
        setStatus(`Error: ${error.message || error}`);
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Submit";
        isRunning = false;
      }
    });
  }

  function setStatus(message) {
    const status = document.querySelector("#nucomply-bulk-widget .ncb-status");
    if (status) status.textContent = message;
  }

function init() {
  const allowedPaths = [
    "/compliance/control-testing/check-result",
    "/compliance/control-testing/run-details",
  ];

  const isAllowedPath = allowedPaths.some((allowedPath) =>
    window.location.pathname.startsWith(allowedPath)
  );

  if (!isAllowedPath) {
    return;
  }

  createWidget();
}

  init();

  let lastUrl = location.href;

  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(init, 700);
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
