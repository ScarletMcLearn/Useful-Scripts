// ==UserScript==
// @name         Messenger Fake Message Adder (Final Fix)
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Add fake messages in Facebook Messenger Web
// @match        *://*.messenger.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    function waitForChatContainer(callback) {
        const checkExist = setInterval(() => {
            const chatContainer = document.querySelector('[role="main"] [aria-label="Messages"]');
            if (chatContainer) {
                clearInterval(checkExist);
                callback(chatContainer);
            }
        }, 1000);
    }

    function addMessage(content, isUser = true) {
        waitForChatContainer((chatContainer) => {
            if (!content.trim()) return; // Ignore empty messages

            // Locate the correct message container inside Messenger
            const messageList = chatContainer.querySelector('div.x78zum5.xdt5ytf');
            if (!messageList) return;

            // Create the outer message wrapper
            const messageWrapper = document.createElement('div');
            messageWrapper.className = "xdj266r x11i5rnm xat24cr x1mh8g0r x14ctfv x1okitfd x6ikm8r x10wlt62 xerhiuh x1pn3fxy x12xxe5f x1szedp3 x1n2onr6 x1vjfegm x1k4qllp x1mzt3pk x13faqbe x11jlvup xpmdkuv x154zaqr x12z03op xyhp3ou x13fuv20 xu3j5b3 x1q0q8m5 x26u7qi x12lizq0 xf766zg x1ybe9c6 x1ts5dru xp5s12f x11ucwad xgtuqic x155c047";
            messageWrapper.style.display = "flex";
            messageWrapper.style.margin = "8px 0";

            // Create the text span
            const messageSpan = document.createElement('span');
            messageSpan.className = "x1lliihq x1plvlek xryxfnj x1n2onr6 x1ji0vk5 x18bv5gf x193iq5w xeuugli x13faqbe x1vvkbs x1s928wv xhkezso x1gmr53x x1cpjm7i x1fgarty x1943h6x x1xmvt09 x6prxxf x1fcty0u x14ctfv xudqn12 x3x7a5m xq9mrsl";
            messageSpan.setAttribute("dir", "auto");

            // Create the message text container
            const messageText = document.createElement('div');
            messageText.className = "html-div xexx8yu x4uap5 x18d9i69 xkhd6sd x1gslohp x11i5rnm x12nagc x1mh8g0r x1yc453h x126k92a xyk4ms5";
            messageText.setAttribute("dir", "auto");
            messageText.innerText = content;

            // Apply styling for sender or receiver
            if (isUser) {
                messageWrapper.style.justifyContent = "flex-end";
                messageText.style.background = "#0084FF"; // Messenger Blue
                messageText.style.color = "#FFFFFF";
            } else {
                messageWrapper.style.justifyContent = "flex-start";
                messageText.style.background = "#E4E6EB"; // Messenger Grey
                messageText.style.color = "#000000";
            }

            messageText.style.padding = "10px 15px";
            messageText.style.borderRadius = "20px";
            messageText.style.maxWidth = "60%";
            messageText.style.wordWrap = "break-word";

            // Build the message structure
            messageSpan.appendChild(messageText);
            messageWrapper.appendChild(messageSpan);

            // Append to chat
            messageList.appendChild(messageWrapper);
            messageList.scrollTop = messageList.scrollHeight; // Auto-scroll
        });
    }

    function createUI() {
        const buttonContainer = document.createElement('div');
        buttonContainer.style.position = 'fixed';
        buttonContainer.style.bottom = '20px';
        buttonContainer.style.right = '20px';
        buttonContainer.style.background = 'white';
        buttonContainer.style.border = '1px solid #ccc';
        buttonContainer.style.padding = '10px';
        buttonContainer.style.borderRadius = '10px';
        buttonContainer.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.2)';
        buttonContainer.style.zIndex = '10000';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.flexDirection = 'column';
        buttonContainer.style.alignItems = 'center';

        const inputField = document.createElement('input');
        inputField.type = 'text';
        inputField.placeholder = 'Enter message...";
        inputField.style.width = '200px';
        inputField.style.padding = '5px';
        inputField.style.marginBottom = '5px';
        inputField.style.border = '1px solid #ccc';
        inputField.style.borderRadius = '5px';

        const buttonGroup = document.createElement('div');
        buttonGroup.style.display = 'flex';
        buttonGroup.style.gap = '5px';

        const sendButton = document.createElement('button');
        sendButton.innerText = 'Send (You)';
        sendButton.style.padding = '5px';
        sendButton.style.cursor = 'pointer';
        sendButton.onclick = () => {
            addMessage(inputField.value, true);
            inputField.value = '';
        };

        const receiveButton = document.createElement('button');
        receiveButton.innerText = 'Receive (Them)';
        receiveButton.style.padding = '5px';
        receiveButton.style.cursor = 'pointer';
        receiveButton.onclick = () => {
            addMessage(inputField.value, false);
            inputField.value = '';
        };

        buttonGroup.appendChild(sendButton);
        buttonGroup.appendChild(receiveButton);
        buttonContainer.appendChild(inputField);
        buttonContainer.appendChild(buttonGroup);
        document.body.appendChild(buttonContainer);
    }

    // Wait for Messenger to load before creating UI
    setTimeout(createUI, 5000);
})();
