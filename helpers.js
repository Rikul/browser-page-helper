// Helpers for page context and tabs
const MAX_PAGE_CHARS = 30000;
const MAX_SELECTION_CHARS = 5000;

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

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

async function getPageContext(tab) {
    if (!tab) return null;

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

export { getActiveTab, getPageContext };