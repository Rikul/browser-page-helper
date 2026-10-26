// Side panel: chat UI + page context + OpenAI-compatible streaming request.

const DEFAULTS = {
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "",
  model: "deepseek/deepseek-v4.1-flash",
};
const MAX_PAGE_CHARS = 30000;
const MAX_SELECTION_CHARS = 5000;

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
// Chat history for this panel session: [{role, content}] (text only).
let history = [];
let controller = null;

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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshTitle() {
  const tab = await getActiveTab();
  const title = tab?.title || tab?.url || "No page";
  els.pageTitle.textContent = title;
  els.pageTitle.title = tab?.url || "";
}

chrome.tabs.onActivated.addListener(refreshTitle);
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && (info.title || info.url || info.status === "complete")) refreshTitle();
});
chrome.windows?.onFocusChanged?.addListener(refreshTitle);

// Runs inside the web page: returns the rendered text the user sees.
function extractPage() {
  return {
    title: document.title,
    url: location.href,
    selection: String(window.getSelection() || ""),
    text: document.body ? document.body.innerText : "",
  };
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + `\n…[truncated, ${s.length - n} more chars]` : s;
}

async function getPageContext(tab) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPage,
  });
  return {
    ...result,
    text: truncate(result.text.trim(), MAX_PAGE_CHARS),
    selection: truncate(result.selection.trim(), MAX_SELECTION_CHARS),
  };
}

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
  div.textContent = text;
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
  if (controller) controller.abort();
  history = [];
  els.messages.innerHTML = '<div class="empty">Ask anything about the current page.</div>';
});

// ---------- Sending ----------

async function send() {
  const text = els.input.value.trim();
  if (!text || controller) return;
  if (!settings.apiKey || !settings.baseUrl || !settings.model) {
    els.settings.hidden = false;
    addMessage("notice", "Set the base URL, API key and model first.");
    return;
  }

  els.input.value = "";
  addMessage("user", text);

  const tab = await getActiveTab();
  let page = null;
  let screenshot = null;

  if (els.includePage.checked && tab) {
    try {
      page = await getPageContext(tab);
    } catch (err) {
      addMessage("notice", `Can't read this page (${err.message}). Answering without it.`);
    }
  }
  if (els.includeShot.checked && tab) {
    try {
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    } catch (err) {
      addMessage("notice", `Screenshot failed (${err.message}).`);
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
    ...history,
    { role: "user", content: userContent },
  ];

  const bubble = addMessage("assistant", "", "pending");
  controller = new AbortController();
  setBusy(true);

  let reply = "";
  try {
    reply = await streamChat(messages, controller.signal, (delta) => {
      bubble.textContent += delta;
      scrollToBottom();
    });
    history.push({ role: "user", content: text }, { role: "assistant", content: reply });
  } catch (err) {
    if (err.name === "AbortError") {
      const partial = bubble.textContent;
      bubble.textContent = partial ? `${partial}\n\n(stopped)` : "(stopped)";
      if (partial) {
        history.push({ role: "user", content: text }, { role: "assistant", content: partial });
      }
    } else {
      bubble.classList.add("error");
      bubble.textContent = err.message;
    }
  } finally {
    bubble.classList.remove("pending");
    controller = null;
    setBusy(false);
    els.input.focus();
  }
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

  for (;;) {
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
els.stopBtn.addEventListener("click", () => controller?.abort());
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

loadSettings();
refreshTitle();
