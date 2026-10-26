// Side panel: chat UI + page context + OpenAI-compatible streaming request.
import { getActiveTab, getPageContext } from './helpers.js';
import { renderMarkdown } from './markdown.js';

const DEFAULTS = {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "",
    model: "deepseek/deepseek-v4.1-flash",
};
const MAX_HISTORY = 100; // messages per tab (50 user/assistant pairs)

const $ = (id) => document.getElementById(id);
const els = {
    pageTitle: $("page-title"),
    settingsBtn: $("settings-btn"),
    clearBtn: $("clear-btn"),
    settings: $("settings"),
    baseUrl: $("base-url"),
    apiKey: $("api-key"),
    model: $("model"),
    settingsStatus: $("settings-status"),
    messages: $("messages"),
    includePage: $("include-page"),
    includeShot: $("include-shot"),
    input: $("input"),
    sendBtn: $("send-btn"),
    stopBtn: $("stop-btn"),
};

let settings = { ...DEFAULTS };

// Chat history for the active tab: [{role, content}] (text only).
let history = [];
let currentTabId = null;

// Loaded histories by tab id. Keeping one array per tab means a reply that
// finishes after you switch away and back is added to the chat you're seeing.
const convos = new Map();

// Replies still streaming, by tab id: { controller, userText, notices, reply, bubble, cleared }.
// Each tab can stream its own reply; switching tabs doesn't stop it.
const streams = new Map();

// ---------- Per-tab history ----------
// Stored in storage.session: tab ids are only valid until the browser restarts,
// so session storage (cleared on restart) matches their lifetime.

const historyKey = (tabId) => `history_${tabId}`;

async function loadHistory(tabId) {
    if (convos.has(tabId)) return convos.get(tabId);
    const key = historyKey(tabId);
    const stored = await chrome.storage.session.get(key);
    // Another call may have filled the cache while this one waited.
    if (!convos.has(tabId)) convos.set(tabId, stored[key] || []);
    return convos.get(tabId);
}

function saveHistory(tabId, convo) {
    // Keep only the latest MAX_HISTORY messages (trims in place, so the live chat shrinks too).
    convo.splice(0, Math.max(0, convo.length - MAX_HISTORY));
    return chrome.storage.session.set({ [historyKey(tabId)]: convo });
}

function clearHistory(tabId) {
    convos.delete(tabId);
    return chrome.storage.session.remove(historyKey(tabId));
}

function renderHistory() {
    els.messages.innerHTML = '<div class="empty">Ask anything about the current page.</div>';
    for (const m of history) addMessage(m.role, m.content);

    // A reply may still be streaming for this tab: show it and keep it updating here.
    const stream = streams.get(currentTabId);
    if (stream) {
        addMessage("user", stream.userText);
        for (const msg of stream.notices) addMessage("notice", msg);
        stream.bubble = addMessage("assistant", stream.reply, "pending");
    }
    setBusy(Boolean(stream));
}

function stopStream(tabId, { discard = false } = {}) {
    const stream = streams.get(tabId);
    if (!stream) return;
    if (discard) {
        stream.cleared = true; // tells send() not to save the reply
        streams.delete(tabId); // and keeps it out of the chat from now on
    }
    stream.controller.abort();
}

// Point the panel at the active tab: update the title and show that tab's chat.
async function syncToActiveTab() {
    const tab = await getActiveTab();
    const title = tab?.title || tab?.url || "No page";
    els.pageTitle.textContent = title;
    els.pageTitle.title = tab?.url || "";

    if (!tab || tab.id === currentTabId) return;
    currentTabId = tab.id;
    const loaded = await loadHistory(tab.id);
    if (currentTabId !== tab.id) return; // user switched again while loading
    history = loaded;
    renderHistory();
}

chrome.tabs.onRemoved.addListener((tabId) => {
    stopStream(tabId, { discard: true });
    clearHistory(tabId);
});

// ---------- Settings ----------

async function loadSettings() {
    const stored = await chrome.storage.local.get(DEFAULTS);
    settings = { ...DEFAULTS, ...stored };
    els.baseUrl.value = settings.baseUrl;
    els.apiKey.value = settings.apiKey;
    els.model.value = settings.model;
    if (!settings.apiKey) els.settings.hidden = false;
}

els.settings.addEventListener("submit", async (e) => {
    e.preventDefault();
    settings = {
        baseUrl: els.baseUrl.value.trim().replace(/\/+$/, ""),
        apiKey: els.apiKey.value.trim(),
        model: els.model.value.trim(),
    };
    await chrome.storage.local.set(settings);
    els.baseUrl.value = settings.baseUrl;
    els.settingsStatus.textContent = "Saved.";
    setTimeout(() => {
        els.settingsStatus.textContent = "";
        els.settings.hidden = true;
    }, 1500);
});

els.settingsBtn.addEventListener("click", () => {
    els.settings.hidden = !els.settings.hidden;
});

// ---------- Current tab ----------

chrome.tabs.onActivated.addListener(syncToActiveTab);
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (tab.active && (info.title || info.url || info.status === "complete")) syncToActiveTab();
});
chrome.windows?.onFocusChanged?.addListener(syncToActiveTab);

function buildSystemPrompt(page) {
    let prompt =
        "You are a helpful assistant inside a browser side panel. " +
        "Answer the user's questions, using the web page below when relevant. " +
        "Be concise.";
    if (page) {
        prompt += `\n\n--- Current page ---\nTitle: ${page.title}\nURL: ${page.url}`;
        if (page.selection) prompt += `\n\nSelected text:\n${page.selection}`;
        prompt += `\n\nPage content:\n${page.text}`;
    }
    return prompt;
}

// ---------- Messages UI ----------

function addMessage(role, text, extraClass = "") {
    els.messages.querySelector(".empty")?.remove();
    const div = document.createElement("div");
    div.className = `msg ${role} ${extraClass}`.trim();
    if (role === "assistant") renderMarkdown(text, div);
    else div.textContent = text;
    els.messages.appendChild(div);
    scrollToBottom();
    return div;
}

function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
}

function setBusy(busy) {
    els.sendBtn.hidden = busy;
    els.stopBtn.hidden = !busy;
    els.input.disabled = busy;
}

els.clearBtn.addEventListener("click", () => {
    stopStream(currentTabId, { discard: true });
    history = [];
    if (currentTabId != null) {
        clearHistory(currentTabId);
        convos.set(currentTabId, history);
    }
    renderHistory();
});

// ---------- Sending ----------

async function send() {
    const text = els.input.value.trim();
    if (!text || streams.has(currentTabId)) return;
    if (!settings.apiKey || !settings.baseUrl || !settings.model) {
        els.settings.hidden = false;
        addMessage("notice", "Set the base URL, API key and model first.");
        return;
    }

    // Pin this tab's conversation now, so the reply is saved to the right tab
    // even if the user switches tabs while the page is read or the reply streams.
    const tabId = currentTabId;
    const convo = history;
    const stream = {
        controller: new AbortController(),
        userText: text,
        notices: [],
        reply: "",
        bubble: null,
        cleared: false,
        frame: 0,
    };
    streams.set(tabId, stream);

    els.input.value = "";
    addMessage("user", text);
    stream.bubble = addMessage("assistant", "", "pending");
    setBusy(true);

    // Notices go above the reply bubble. They're kept on the stream too, so
    // renderHistory() can show them if the user switches away and back.
    const notice = (msg) => {
        stream.notices.push(msg);
        const div = document.createElement("div");
        div.className = "msg notice";
        div.textContent = msg;
        stream.bubble.before(div);
    };

    const tab = await getActiveTab();
    let page = null;
    let screenshot = null;

    if (els.includePage.checked && tab) {
        try {
            page = await getPageContext(tab);
        } catch (err) {
            notice(`Can't read this page (${err.message}). Answering without it.`);
        }
    }
    if (els.includeShot.checked && tab) {
        try {
            screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        } catch (err) {
            notice(`Screenshot failed (${err.message}).`);
        }
    }

    const userContent = screenshot
        ? [
            { type: "text", text },
            { type: "image_url", image_url: { url: screenshot } },
        ]
        : text;

    const messages = [
        { role: "system", content: buildSystemPrompt(page) },
        ...convo,
        { role: "user", content: userContent },
    ];

    // Re-render the Markdown at most once per frame while chunks arrive.
    const render = () => {
        cancelAnimationFrame(stream.frame);
        stream.frame = 0;
        renderMarkdown(stream.reply, stream.bubble);
        if (stream.bubble.isConnected) scrollToBottom();
    };

    try {
        await streamChat(messages, stream.controller.signal, (delta) => {
            stream.reply += delta;
            if (!stream.frame) stream.frame = requestAnimationFrame(render);
        });
        render();
        convo.push({ role: "user", content: text }, { role: "assistant", content: stream.reply });
    } catch (err) {
        if (err.name === "AbortError") {
            render();
            const stopped = document.createElement("div");
            stopped.className = "stopped";
            stopped.textContent = "(stopped)";
            stream.bubble.append(stopped);
            if (stream.reply && !stream.cleared) {
                convo.push({ role: "user", content: text }, { role: "assistant", content: stream.reply });
            }
        } else {
            cancelAnimationFrame(stream.frame);
            stream.bubble.classList.add("error");
            stream.bubble.textContent = err.message;
        }
    } finally {
        stream.bubble.classList.remove("pending");
        if (streams.get(tabId) === stream) streams.delete(tabId);
        if (tabId === currentTabId && !streams.has(tabId)) {
            setBusy(false);
            els.input.focus();
        }
    }
    if (tabId != null && !stream.cleared) saveHistory(tabId, convo);
}

// POST {baseUrl}/chat/completions with stream: true and parse the SSE stream.
// Calls onDelta(text) per chunk; resolves with the full reply.
async function streamChat(messages, signal, onDelta) {
    const res = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({ model: settings.model, messages, stream: true }),
        signal,
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText}\n${body}`.trim());
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep the partial last line

        for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith("data:")) continue; // skip comments / keep-alives
            const data = line.slice(5).trim();
            if (data === "[DONE]") return full;
            let json;
            try {
                json = JSON.parse(data);
            } catch {
                continue;
            }
            if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
                full += delta;
                onDelta(delta);
            }
        }
    }
    return full;
}

els.sendBtn.addEventListener("click", send);
els.stopBtn.addEventListener("click", () => stopStream(currentTabId));
els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
    }
});

loadSettings();
syncToActiveTab();
