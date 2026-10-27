# Browser Page Helper

A minimal Chrome extension that opens a chat panel on the right side of the browser. Your questions are sent, along with the current page's content, to any OpenAI-compatible API, such as OpenRouter, OpenAI, a local Ollama or LM Studio.

```
you → side panel → (page text [+ screenshot] + question) → POST {baseUrl}/chat/completions → streamed reply
```

There's no build step and there are no dependencies. It's plain HTML, CSS and JS on Manifest V3.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. Pin the extension, then click its toolbar icon to open the side panel.
5. Click the gear icon and set the **Base URL**, **API key** and **Model**, then click **Save**.

After you change the code, click the reload icon on the extension's card in `chrome://extensions` and reopen the panel.

## Settings

| Field | Example |
|---|---|
| Base URL | `https://openrouter.ai/api/v1`, `https://api.openai.com/v1`, `http://localhost:11434/v1` |
| API key | Your key. Any non-empty value works for local servers that don't check it. |
| Model | `deepseek/deepseek-v4.1-flash`, `gpt-4o-mini`, `llama3.1` |

The extension calls `{Base URL}/chat/completions` with `stream: true`.

## Page context

- **Page text** (always sent): the page title, URL, any selected text, and the *rendered* text of the page (`document.body.innerText`, which is what's visible, without scripts or markup), capped at 30k characters.
- **Send Screenshot** (on by default, remembered): also sends a PNG of the visible part of the tab as an `image_url`. Turn it off if your model can't read images.

The context is read again on every message, so it always matches the tab you're on. Chrome doesn't let extensions read some pages, such as `chrome://` pages, the Web Store and the built-in PDF viewer. On those, the panel answers without page context and shows a notice.

## Ask about a selection

Select text on a page, right-click it and choose **Ask Page Helper about this**. The panel opens, and the selection is quoted in the message box so you can type your question under it. The selection is also sent as page context, as with any message.

## Chat history

Each tab has its own conversation. When you switch tabs, the panel shows that tab's chat, and the earlier messages are sent to the model as context.

- History lasts for the browser session. It's deleted when you close the tab or restart the browser.
- Each tab keeps only its latest 100 messages (`MAX_HISTORY` in `sidepanel.js`).
- History is text only. Page content and screenshots are sent with each message but aren't saved.
- **Clear chat** (the circular-arrow icon) deletes the current tab's history.
- A reply keeps streaming if you switch tabs. Switch back to see it finish. Each tab can have its own reply in progress.

## Replies

Replies are shown as Markdown: headings, lists, code blocks, tables, links, bold and italic. Turn the **Render Markdown** toggle (on by default, remembered) off to see the raw text instead. Hover a reply to copy its text. Links open in a new tab and only `http`, `https` and `mailto` links are kept. Images in replies are shown as links, so the panel never loads remote images.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Permissions and entry points (MV3). |
| `background.js` | Service worker. Makes the toolbar icon open the side panel, and adds the right-click menu item. |
| `sidepanel.html` / `.css` | The chat UI. |
| `sidepanel.js` | Settings, per-tab chat history (`chrome.storage.session`), and the streaming request. |
| `helpers.js` | Active tab lookup and page extraction (`chrome.scripting`). |
| `markdown.js` | Renders replies as Markdown. Builds DOM nodes directly (no `innerHTML`), so replies can't inject HTML. |

## Privacy

- The page content (and screenshot, if enabled) is sent to the endpoint you configure, and nowhere else.
- The API key is stored in `chrome.storage.local` on this device. Chat history is stored in `chrome.storage.session`, which lives in memory and is cleared when the browser closes.
- The extension asks for access to all sites (`<all_urls>`) so it can read whichever tab is active and call any API URL.
