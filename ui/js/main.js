// Temporary boot: proves the new shell, styles and fonts load. Replaced by the real boot
// (token, theme, store, shell, router) in the components + shell task.
const view = document.getElementById('view');
const title = document.createElement('h1');
title.textContent = 'coldtrail';
view.replaceChildren(title);
