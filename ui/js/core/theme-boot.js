// A classic script (not a module), loaded by index.html ahead of the stylesheets: it pins a chosen
// Light or Dark theme before the first paint. main.js is a module and runs after the page has
// painted, so a theme left to it shows the system one first. Keep in step with theme.js (the
// "ct-theme" key and its values), which takes over once the app has loaded.
(function () {
  try {
    var pref = localStorage.getItem('ct-theme');
    if (pref === 'light' || pref === 'dark') document.documentElement.setAttribute('data-theme', pref);
  } catch (_) {
    /* storage unavailable: System */
  }
})();
