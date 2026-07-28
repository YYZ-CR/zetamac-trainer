// The page script for privacy.html and terms.html.
//
// Those two pages are static prose. The only thing they need a script for is
// the shared header, which js/auth.js builds from a session lookup — without
// this the top bar renders as an empty strip and the nav "randomly disappears"
// on exactly two pages, which is the bug NAV was consolidated to prevent.
//
// No build step: one global scope. Nothing here is top-level except this
// listener, so there is no name to collide with.
document.addEventListener('DOMContentLoaded', async () => {
  // The header offers Log in / Register, and those buttons need something to
  // open. Cheap, and it keeps the bar behaving the same as everywhere else.
  createAuthModal();

  let user = null;
  try {
    user = await initAuth({
      onAuthChange: u => renderAuthBar(u, document.getElementById('top-bar')),
    });
  } catch (e) { console.warn('initAuth failed:', e); }
  renderAuthBar(user, document.getElementById('top-bar'));
});
