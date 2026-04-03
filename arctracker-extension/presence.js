(() => {
  // Content scripts run in an isolated JavaScript world, so setting window properties
  // here won't be visible to the page's JavaScript. We need to inject a script element
  // that runs in the PAGE's context to set the window property.
  const script = document.createElement("script");
  script.textContent = "window.__ARCTRACKER_EXTENSION_INSTALLED__ = true;";
  (document.head || document.documentElement).appendChild(script);
  script.remove(); // Clean up - the code already executed
})();
