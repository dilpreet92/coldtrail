// Theme preference (spec §2): System (default) / Light / Dark in localStorage "ct-theme".
// System removes data-theme so tokens.css follows prefers-color-scheme; Light/Dark pin it.
// Storage can throw (privacy modes): the choice then holds for this page only. theme-boot.js, a
// classic script in index.html, applies the stored choice before the first paint; keep the two in
// step.

const KEY = 'ct-theme';
const PREFS = ['system', 'light', 'dark'];
let sessionPref = null; // last choice made on this page, used when storage is unavailable

/** 'system' | 'light' | 'dark'. */
export function getThemePref() {
  if (sessionPref) return sessionPref;
  try {
    const v = localStorage.getItem(KEY);
    if (PREFS.includes(v)) return v;
  } catch (_) {
    /* storage unavailable */
  }
  return 'system';
}

/** Save the preference (anything unknown means 'system') and apply it. */
export function setThemePref(pref) {
  sessionPref = PREFS.includes(pref) ? pref : 'system';
  try {
    if (sessionPref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, sessionPref);
  } catch (_) {
    /* storage unavailable: keep it for this page */
  }
  applyTheme();
}

/** Reflect the preference on <html>; returns it. */
export function applyTheme() {
  const pref = getThemePref();
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
  return pref;
}
