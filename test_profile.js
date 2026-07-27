// test_profile.js — Node.js tests for the pure helpers in js/profile.js.
// Run: node test_profile.js
//
// js/profile.js is a classic script that expects a DOM, so it is loaded into a
// vm sandbox with just enough of `window` to evaluate. Only the functions that
// do not touch the DOM are exercised here; the rendering paths are covered by
// the browser checks instead.
//
// readUsernameFromUrl is the one worth pinning down. vercel.json rewrites
// /@name and /u/name to profile.html?u=name server-side, which means the
// browser keeps the original path and location.search is empty. Reading the
// query string alone renders "no profile requested" for every clean URL, and
// that failure is invisible locally because `npx serve` has no rewrites.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Load js/profile.js into a sandbox ────────────────────────
const src = fs.readFileSync(path.join(__dirname, 'js', 'profile.js'), 'utf8');

const sandbox = {
  console,
  document: {
    // The file registers a DOMContentLoaded handler at load time; swallow it
    // so nothing runs until a test calls a function directly.
    addEventListener() {},
    getElementById() { return null; },
  },
  window: {
    location: { search: '', pathname: '/' },
    addEventListener() {},
  },
  URLSearchParams,
};
sandbox.window.location = sandbox.window.location;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'js/profile.js' });

function atUrl(pathname, search = '') {
  sandbox.window.location.pathname = pathname;
  sandbox.window.location.search   = search;
  return vm.runInContext('readUsernameFromUrl()', sandbox);
}

console.log('\nreadUsernameFromUrl');

// ── The query-string form ────────────────────────────────────
assert('?u=name resolves', atUrl('/profile.html', '?u=hexadecimal') === 'hexadecimal');
assert('surrounding whitespace is trimmed',
  atUrl('/profile.html', '?u=%20hexadecimal%20') === 'hexadecimal');
assert('an empty ?u= falls through to the path, and yields nothing here',
  atUrl('/profile.html', '?u=') === '');
assert('no query string and no clean path yields nothing',
  atUrl('/profile.html', '') === '');

// ── The rewritten forms — the whole reason this function exists ──
assert('/@name resolves',      atUrl('/@hexadecimal') === 'hexadecimal');
assert('/u/name resolves',     atUrl('/u/hexadecimal') === 'hexadecimal');
assert('/@name/ with a trailing slash resolves',
  atUrl('/@hexadecimal/') === 'hexadecimal');
assert('a percent-encoded name is decoded',
  atUrl('/@some%20one') === 'some one');
assert('a name containing @ survives', atUrl('/@a@b') === 'a@b');

// The query string wins when both are present, so an explicit ?u= can always
// override whatever the path happens to say.
assert('?u= takes precedence over the path',
  atUrl('/@fromthepath', '?u=fromthequery') === 'fromthequery');

// ── Shapes that must NOT resolve ─────────────────────────────
assert('the bare root yields nothing',            atUrl('/') === '');
assert('a nested path under /u/ yields nothing',  atUrl('/u/name/extra') === '');
assert('/@ with no name yields nothing',          atUrl('/@') === '');
assert('an ordinary page path yields nothing',    atUrl('/dashboard.html') === '');

// ── Malformed input must not take the page down ──────────────
// decodeURIComponent throws a URIError on a bare '%'. Uncaught, that happens
// before anything renders and the page is simply blank.
let threw = false;
let bare = '';
try { bare = atUrl('/@100%'); } catch (_) { threw = true; }
assert('a malformed percent escape does not throw', !threw);
assert('a malformed percent escape still yields the raw name', bare === '100%');

// ── percentilePercent (js/util.js) ───────────────────────────
// Shared by the profile page and the results page, which is the point: a
// threshold kept in two files drifts, and the drift is invisible until
// someone compares two pages.
console.log('\npercentilePercent');

const utilBox = { console };
vm.createContext(utilBox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'js', 'util.js'), 'utf8'), utilBox);
const pp = (percentile, players) =>
  vm.runInContext('percentilePercent(__r)', Object.assign(utilBox, { __r: { percentile, players } }));

assert('a healthy population renders a whole percent', pp(0.784, 412) === 78);
assert('rounds to nearest',                            pp(0.786, 412) === 79);
assert('a thin population says nothing',               pp(0.9, 19) === null);
assert('exactly at the threshold speaks',              pp(0.5, 20) === 50);
assert('a null percentile says nothing',               pp(null, 400) === null);
assert('a null payload says nothing',
  vm.runInContext('percentilePercent(null)', utilBox) === null);

// The top player's strictly-below fraction rounds to 100, and "faster than
// 100% of players" would include themselves.
assert('a fraction below 1 never claims 100', pp(0.9999, 4000) === 99);
assert('an exact 1.0 is allowed to say 100',  pp(1, 4000) === 100);
assert('the bottom of the field is 0',        pp(0, 400) === 0);

// ── Summary ──────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
