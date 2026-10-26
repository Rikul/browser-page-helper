// Clicking the toolbar icon opens the side panel.
function enablePanelOnClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("setPanelBehavior failed:", err));
}

chrome.runtime.onInstalled.addListener(enablePanelOnClick);
chrome.runtime.onStartup.addListener(enablePanelOnClick);

// ---------- Right-click "Ask Page Helper about this" ----------

const MENU_ID = "ask-about-selection";

// Menus persist across restarts, so create it once per install or update.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Ask Page Helper about this",
      contexts: ["selection"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab) return;
  // open() must run while the click still counts as a user gesture, so it's
  // called before anything is awaited.
  chrome.sidePanel
    .open({ windowId: tab.windowId })
    .catch((err) => console.error("sidePanel.open failed:", err));
  // Hand the selection to that window's panel. An open panel sees the storage
  // change; a panel that's just opening reads it on load. One key per window,
  // so hand-offs to two windows at once don't overwrite each other.
  chrome.storage.session.set({
    [`pendingAsk_${tab.windowId}`]: { text: info.selectionText || "", at: Date.now() },
  });
});
