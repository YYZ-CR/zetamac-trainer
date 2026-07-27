// Theme controller. Loaded in <head>, before the stylesheet renders anything,
// so the stored theme is on <html> ahead of first paint and the page never
// flashes the wrong palette.

const THEMES     = ['zetamac', 'dark'];
const THEME_KEY  = 'zt_theme';

function getTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (THEMES.includes(stored)) return stored;
  } catch (_) {}
  // No explicit choice yet: follow the OS preference, defaulting to the
  // original Zetamac look.
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch (_) {}
  return 'zetamac';
}

function applyTheme(name) {
  const theme = THEMES.includes(name) ? name : 'zetamac';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
  // Charts read their colours from CSS variables at construction time, so they
  // have to be told to re-read them.
  window.dispatchEvent(new CustomEvent('zt-theme-change', { detail: { theme } }));
  return theme;
}

// Run immediately, not on DOMContentLoaded.
applyTheme(getTheme());

// Read a themed colour out of the stylesheet. Chart.js needs concrete values,
// not var() references.
function themeColor(token, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (v) return v;
  } catch (_) {}
  return fallback;
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'zetamac' : 'dark';
  return applyTheme(next);
}

// Small text toggle appended to the auth bar on every page.
function renderThemeToggle(container) {
  if (!container) return;
  let link = container.querySelector('.theme-toggle');
  if (!link) {
    link = document.createElement('a');
    link.href = '#';
    link.className = 'theme-toggle';
    link.addEventListener('click', e => {
      e.preventDefault();
      toggleTheme();
      updateThemeToggleLabel(link);
    });
    if (container.childNodes.length) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '|';
      container.appendChild(sep);
    }
    container.appendChild(link);
  }
  updateThemeToggleLabel(link);
}

function updateThemeToggleLabel(link) {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  link.textContent = dark ? 'Light' : 'Dark';
  link.title = dark ? 'Switch to the Zetamac theme' : 'Switch to the dark theme';
}
