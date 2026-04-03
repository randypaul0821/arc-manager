// Listen for messages from arctracker.io pages
// This enables the website to detect if the extension is installed
chrome.runtime.onMessageExternal.addListener(
  (message, sender, sendResponse) => {
    if (message === "ping" || message?.type === "ping") {
      sendResponse({
        installed: true,
        version: chrome.runtime.getManifest().version,
      });
      return true; // Keep message channel open for async response
    }
  }
);
