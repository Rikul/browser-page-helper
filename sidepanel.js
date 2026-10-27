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
    pageHost: $("page-host"),
    settingsBtn: $("settings-btn"),
    clearBtn: $("clear-btn"),
    settings: $("settings"),
    baseUrl: $("base-url"),
    apiKey: $("api-key"),
    model: $("model"),
    settingsStatus: $("settings-status"),
    settingsCancel: $("settings-cancel"),
    emptyTpl: $("empty-tpl"),
    messages: $("messages"),
    includePage: $("include-page"),
    includeShot: $("include-shot"),
    markdown: $("markdown"),
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
    els.messages.replaceChildren(els.emptyTpl.content.cloneNode(true));
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

function hostOf(url) {
    try {
        const u = new URL(url);
        return u.protocol.startsWith("http") ? u.hostname : u.protocol.replace(":", "");
    } catch {
        return "";
    }
}

// Point the panel at the active tab: update the title and show that tab's chat.
async function syncToActiveTab() {
    const tab = await getActiveTab();
    const title = tab?.title || tab?.url || "No page";
    els.pageTitle.textContent = title;
    els.pageTitle.title = title;
    els.pageHost.textContent = hostOf(tab?.url);
    els.pageHost.title = tab?.url || "";

    if (!tab || tab.id === currentTabId) return;
    currentTabId = tab.id;
    const loaded = await loadHistory(tab.id);
    if (currentTabId !== tab.id) return; // user switched again while loading
    history = loaded;
    renderHistory();
}

// Another window's panel can change a tab's history (tabs can move between
// windows). Keep this panel's cached copy in step, even mid-reply: send()
// adds a finished reply to whatever the cache holds by then.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
        if (!key.startsWith("history_")) continue;
        const tabId = Number(key.slice("history_".length));
        // Another panel cleared this tab's chat: don't save a reply this panel
        // is still streaming for it.
        if (newValue === undefined && streams.has(tabId)) streams.get(tabId).cleared = true;
        const cached = convos.get(tabId);
        const next = newValue || [];
        if (!cached) continue;
        if (JSON.stringify(cached) === JSON.stringify(next)) continue; // this panel's own save
        convos.set(tabId, next);
        if (tabId === currentTabId) {
            history = next;
            renderHistory();
        }
    }
});

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
    if (!settings.apiKey) showSettings(true);
}

function showSettings(show) {
    els.settings.hidden = !show;
    els.settingsBtn.setAttribute("aria-expanded", String(show));
    if (show) els.baseUrl.focus();
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
        showSettings(false);
    }, 1200);
});

els.settingsBtn.addEventListener("click", () => showSettings(els.settings.hidden));
els.settingsCancel.addEventListener("click", () => showSettings(false));
els.settings.addEventListener("keydown", (e) => {
    if (e.key === "Escape") showSettings(false);
});

// ---------- Markdown on/off ----------
// Saved separately from the API settings. On by default.

async function loadMarkdownPref() {
    const { markdown = true } = await chrome.storage.local.get("markdown");
    els.markdown.checked = markdown;
    rerenderReplies();
}

els.markdown.addEventListener("change", () => {
    chrome.storage.local.set({ markdown: els.markdown.checked });
    rerenderReplies();
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

// Raw text of each assistant bubble, so it can be re-rendered or copied.
const replyText = new WeakMap();

function addMessage(role, text, extraClass = "") {
    els.messages.querySelector(".empty")?.remove();
    const div = document.createElement("div");
    div.className = `msg ${role} ${extraClass}`.trim();
    if (role === "assistant") {
        const content = document.createElement("div");
        content.className = "content";
        div.append(content, replyActions(div));
        renderReply(div, text);
    } else {
        div.textContent = text;
    }
    els.messages.appendChild(div);
    scrollToBottom();
    return div;
}

// Render a reply as Markdown or plain text, depending on the toggle.
function renderReply(bubble, text) {
    replyText.set(bubble, text);
    const content = bubble.querySelector(".content");
    if (!content) return; // bubble was replaced by an error
    const md = els.markdown.checked;
    content.className = `content ${md ? "md" : "plain"}`;
    if (md) renderMarkdown(text, content);
    else content.textContent = text;
}

function rerenderReplies() {
    for (const bubble of els.messages.querySelectorAll(".msg.assistant")) {
        if (replyText.has(bubble)) renderReply(bubble, replyText.get(bubble));
    }
}

const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function replyActions(bubble) {
    const actions = document.createElement("div");
    actions.className = "actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.title = "Copy reply";
    copy.innerHTML = `${COPY_ICON}<span>Copy</span>`; // static markup, no model text
    copy.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(replyText.get(bubble) || "");
            copy.innerHTML = `${CHECK_ICON}<span>Copied</span>`;
        } catch {
            copy.lastChild.textContent = "Copy failed";
        }
        setTimeout(() => (copy.innerHTML = `${COPY_ICON}<span>Copy</span>`), 1500);
    });
    actions.append(copy);
    return actions;
}

// Grow the message box with its text, up to the CSS max-height.
function autosize() {
    els.input.style.height = "auto";
    els.input.style.height = `${els.input.scrollHeight}px`;
}

function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
}

function setBusy(busy) {
    els.sendBtn.hidden = busy;
    els.stopBtn.hidden = !busy;
    els.input.disabled = busy;
}

// Starter prompts in the empty chat.
els.messages.addEventListener("click", (e) => {
    const btn = e.target.closest(".suggestion");
    if (!btn) return;
    els.input.value = btn.textContent;
    send();
});

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
        showSettings(true);
        addMessage("notice", "Set the base URL, API key and model first.");
        return;
    }

    // Pin the tab now, so the reply is saved to the right tab even if the user
    // switches tabs while the page is read or the reply streams.
    const tabId = currentTabId;
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
    autosize();
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

    // Get this tab's conversation by id. `history` can still be the previous
    // tab's if the panel is loading this tab's history right after a switch.
    const convo = tabId == null ? history : await loadHistory(tabId);

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
        renderReply(stream.bubble, stream.reply);
        if (stream.bubble.isConnected) scrollToBottom();
    };

    // Add the exchange to the tab's latest history, not the array captured at
    // the start: another window's panel may have saved newer messages since.
    let saved = null;
    const record = () => {
        if (stream.cleared) return;
        saved = convos.get(tabId) ?? convo;
        saved.push({ role: "user", content: text }, { role: "assistant", content: stream.reply });
    };

    try {
        await streamChat(messages, stream.controller.signal, (delta) => {
            stream.reply += delta;
            if (!stream.frame) stream.frame = requestAnimationFrame(render);
        });
        render();
        record();
    } catch (err) {
        if (err.name === "AbortError") {
            render();
            const stopped = document.createElement("div");
            stopped.className = "stopped";
            stopped.textContent = "(stopped)";
            stream.bubble.querySelector(".actions").before(stopped);
            if (stream.reply) record();
        } else {
            cancelAnimationFrame(stream.frame);
            stream.bubble.className = "msg error";
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
    if (tabId != null && saved) saveHistory(tabId, saved);
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
els.input.addEventListener("input", autosize);
els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
    }
});

// ---------- Right-click "Ask Page Helper about this" ----------
// background.js stores the selection in storage.session as pendingAsk_<windowId>.
// The panel for that window quotes it in the input, ready for a question.

const PENDING_MAX_AGE = 60_000; // ignore a hand-off left over from earlier
const pendingKey = chrome.windows.getCurrent().then((win) => `pendingAsk_${win.id}`);

async function takePendingAsk() {
    const key = await pendingKey;
    const { [key]: pendingAsk } = await chrome.storage.session.get(key);
    if (!pendingAsk) return;
    await chrome.storage.session.remove(key);
    if (Date.now() - pendingAsk.at > PENDING_MAX_AGE) return;

    const text = pendingAsk.text.trim();
    if (!text) return;
    const quote = text.split("\n").map((line) => `> ${line}`).join("\n");
    // Keep anything already typed, and add the quote below it.
    const draft = els.input.value.trimEnd();
    els.input.value = draft ? `${draft}\n\n${quote}\n\n` : `${quote}\n\n`;
    els.input.focus();
    els.input.setSelectionRange(els.input.value.length, els.input.value.length);
    autosize();
    els.input.scrollTop = els.input.scrollHeight;
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    const added = Object.entries(changes).some(([k, c]) => k.startsWith("pendingAsk_") && c.newValue);
    if (added) takePendingAsk();
});

renderHistory();
loadSettings();
loadMarkdownPref();
syncToActiveTab();
takePendingAsk();
