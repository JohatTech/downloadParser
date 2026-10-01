/**
 * Background Service Worker for YouTube Playlist MP3 Converter Extension.
 * Handles side-panel behavior, file downloads, and runtime messaging.
 */

// Enable side panel opening on extension icon click when supported
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.warn("Could not set panel behavior:", err);
    });
  }
  console.log("YouTube Playlist MP3 Converter extension installed successfully.");
});

// Listen for messages from side panel or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "DOWNLOAD_FILE") {
    const { url, filename } = message.payload;
    
    chrome.downloads.download(
      {
        url: url,
        filename: filename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("Download error:", chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId: downloadId });
        }
      }
    );
    return true; // Keep message channel open for async response
  }

  if (message.action === "GET_ACTIVE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0) {
        sendResponse({ success: true, tab: tabs[0] });
      } else {
        sendResponse({ success: false, error: "No active tab found" });
      }
    });
    return true;
  }
});
