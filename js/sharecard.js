// Client-side share card.
//
// Renders a 1200×630 PNG of a run (or a profile's best) entirely in the
// browser: no serverless function, no build step, no webfont, no network call
// at render time. The image carries the site host, so every paste into Discord
// or Slack is a referral.
//
// Nothing here runs on page load. The canvas is built inside the click
// handler and thrown away afterwards — a 2400×1260 backing store is ~12 MB of
// RAM and there is no reason for a results page to be carrying that around on
// the chance somebody presses a button.
//
// Loaded on results.html and profile.html, which each already define their own
// globals in the same shared scope (classic scripts, no modules). Every
// identifier here is therefore prefixed — profile.js already owns `OP_ORDER`
// and `OP_SYMBOL`, and a duplicate top-level `const` is a SyntaxError that
// blanks the whole page rather than breaking one feature.

// 1200×630 is the OG/Twitter card aspect. Chat clients shrink it hard, hence
// the 2x backing store and the deliberately large type scale below.
const SHARE_CARD_W     = 1200;
const SHARE_CARD_H     = 630;
const SHARE_CARD_SCALE = 2;

const SHARE_OP_ORDER = ['addition', 'subtraction', 'multiplication', 'division'];
const SHARE_OP_GLYPH = {
  addition:       '+',
  subtraction:    '−',
  multiplication: '×',
  division:       '÷',
};

// ── Theme ─────────────────────────────────────────────────────
// Every colour is resolved from the live CSS custom properties through
// themeColor() (js/theme.js), at click time, so the card matches whichever
// theme the player is looking at. Nothing here is a literal except the
// fallbacks, which only apply if the stylesheet failed to load at all.

function shareCardColors() {
  const c = (typeof themeColor === 'function')
    ? themeColor
    : (_t, fallback) => fallback;
  return {
    page:    c('--c-page-bg',     '#d4d4d4'),
    surface: c('--c-surface',     '#fff'),
    border:  c('--c-border',      '#bbb'),
    rule:    c('--c-border-soft', '#ddd'),
    accent:  c('--c-accent',      '#333'),
    max:     c('--c-ink-max',     '#000'),
    body:    c('--c-ink-body',    '#444'),
    strong:  c('--c-ink-strong',  '#333'),
    muted:   c('--c-ink-muted',   '#555'),
    soft:    c('--c-ink-soft',    '#666'),
    faint:   c('--c-ink-faint',   '#777'),
  };
}

// The site uses Arial in the Zetamac theme and a monospace stack in the dark
// theme (see the `:root[data-theme="dark"] body` rule in css/style.css). The
// card mirrors that so it reads as the same product. System stacks only —
// a webfont would mean a network request at render time and a blank card
// whenever it failed.
function shareCardFontStack() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return dark
    ? '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace'
    : 'Arial, Helvetica, sans-serif';
}

// ── Text helpers ──────────────────────────────────────────────

// Largest size at or below `size` at which the text fits `maxWidth`. Long
// usernames and four-digit scores are the realistic overflow cases, and a
// clipped card is worse than a slightly smaller line.
function shareCardFit(ctx, text, weight, size, stack, maxWidth) {
  let s = size;
  while (s > 11) {
    ctx.font = `${weight} ${s}px ${stack}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    s -= 2;
  }
  ctx.font = `${weight} ${s}px ${stack}`;
  return s;
}

// A measured line: the actual ink height above the baseline, so blocks can be
// stacked from real metrics rather than from guesses about the font.
function shareCardMeasure(ctx, text, weight, size, stack, maxWidth) {
  const fitted = shareCardFit(ctx, text, weight, size, stack, maxWidth);
  const m = ctx.measureText(text);
  const ascent = Number.isFinite(m.actualBoundingBoxAscent) && m.actualBoundingBoxAscent > 0
    ? m.actualBoundingBoxAscent
    : fitted * 0.72;
  return { text, weight, size: fitted, ascent, width: m.width };
}

function shareCardDrawLine(ctx, line, x, baseline, color, stack, align) {
  ctx.font = `${line.weight} ${line.size}px ${stack}`;
  ctx.fillStyle = color;
  ctx.textAlign = align || 'left';
  ctx.fillText(line.text, x, baseline);
  ctx.textAlign = 'left';
}

// Letter-spaced small caps for the eyebrow. Drawn glyph by glyph rather than
// through ctx.letterSpacing, which Firefox and older Safari do not implement —
// there it would silently render untracked and look like a mistake.
function shareCardDrawTracked(ctx, text, x, baseline, weight, size, stack, color, tracking) {
  ctx.font = `${weight} ${size}px ${stack}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, baseline);
    cx += ctx.measureText(ch).width + tracking;
  }
}

function shareCardRoundRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

// ── Data adapters ─────────────────────────────────────────────
// The two pages hold different shapes. Both normalise to:
//
//   { kind: 'run'|'best', score, duration, ops: [name],
//     opStats: [{ name, avgMs }], percentile: number|null, username: string }

// A finished run, straight off the results page's session object.
function shareCardDataFromSession(session, extra) {
  const opts = extra || {};
  const qs   = Array.isArray(session && session.questions) ? session.questions : [];

  const byOp = {};
  for (const q of qs) {
    const name = q && q.operation;
    if (!name) continue;
    if (!byOp[name]) byOp[name] = { totalMs: 0, count: 0 };
    byOp[name].totalMs += Number(q.timeMs) || 0;
    byOp[name].count   += 1;
  }

  // SHARE_OP_ORDER first so the glyph run always reads "+ − × ÷"; anything
  // unrecognised (a future operation) still shows up, just after them.
  const names = [
    ...SHARE_OP_ORDER.filter(n => byOp[n]),
    ...Object.keys(byOp).filter(n => !SHARE_OP_ORDER.includes(n)),
  ];

  return {
    kind:       'run',
    score:      Number(session && session.score),
    duration:   Number(session && (session.durationSeconds ?? session.duration_seconds)),
    ops:        names,
    opStats:    names.map(n => ({ name: n, avgMs: byOp[n].totalMs / byOp[n].count })),
    percentile: opts.percentile ?? null,
    username:   String(opts.username || '').trim(),
  };
}

// A public profile's best, off the get_public_profile payload.
// `duration` is chosen by the caller, because the percentile it may be paired
// with is only ever computed for one duration.
function shareCardDataFromProfile(profile, extra) {
  const opts     = extra || {};
  const p        = profile || {};
  const bests    = (p.bests && typeof p.bests === 'object') ? p.bests : {};
  const duration = Number(opts.duration);
  const score    = Number(bests[String(duration)] ?? bests[duration]);

  const ops   = (p.ops && typeof p.ops === 'object') ? p.ops : {};
  const names = [
    ...SHARE_OP_ORDER.filter(n => ops[n] && Number.isFinite(Number(ops[n].avg_ms))),
    ...Object.keys(ops).filter(n => !SHARE_OP_ORDER.includes(n) && Number.isFinite(Number(ops[n].avg_ms))),
  ];

  return {
    kind:       'best',
    score,
    duration,
    ops:        names,
    opStats:    names.map(n => ({ name: n, avgMs: Number(ops[n].avg_ms) })),
    percentile: opts.percentile ?? null,
    username:   String(p.username || '').trim(),
  };
}

// ── Copy ──────────────────────────────────────────────────────

function shareCardSubtitle(data) {
  const parts = [];
  if (data.kind === 'best') parts.push('personal best');
  if (Number.isFinite(data.duration) && data.duration > 0) parts.push(`${data.duration} seconds`);
  const glyphs = (data.ops || []).map(n => SHARE_OP_GLYPH[n] || '').filter(Boolean);
  if (glyphs.length) parts.push(glyphs.join(' '));
  return parts.join('  ·  ');
}

// Host only, resolved at render time. There is no configured site URL
// anywhere in the project and inventing one here would guarantee it goes
// stale; the page knows where it is being served from.
function shareCardSiteUrl() {
  try {
    const host = String(window.location.host || '').replace(/^www\./, '');
    if (host) return host;
  } catch (_) {}
  return 'arithmetic trainer';
}

function shareCardFilename(data) {
  const bits = ['arithmetic-trainer'];
  if (Number.isFinite(data.score)) bits.push(String(data.score));
  if (Number.isFinite(data.duration) && data.duration > 0) bits.push(`${data.duration}s`);
  return bits.join('-') + '.png';
}

// ── Render ────────────────────────────────────────────────────
//
// Layout, top to bottom, in CSS px on a 1200×630 field (2x backing store):
//
//   24        surface card inset, 8px accent stripe down its left edge
//   100       eyebrow  ARITHMETIC TRAINER            20px tracked, ink-faint
//   ~284      SCORE                                  168px bold, ink-max
//   +16       "120 seconds · + − × ÷"                36px,  ink-body
//   +20       "Faster than 78% of players"           30px semibold, accent
//   +32       hairline rule
//   +32       per-operation row, one column each     42px glyph / 26px avg
//   562       @username (left)          host (right) 24px / 22px
//
// The middle block is vertically centred between the eyebrow and the footer,
// so dropping the percentile (thin population) or the operation row (no
// questions) rebalances the card instead of leaving a hole in it.
function renderShareCard(data) {
  const canvas = document.createElement('canvas');
  canvas.width  = SHARE_CARD_W * SHARE_CARD_SCALE;
  canvas.height = SHARE_CARD_H * SHARE_CARD_SCALE;

  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');

  ctx.scale(SHARE_CARD_SCALE, SHARE_CARD_SCALE);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign    = 'left';

  const col   = shareCardColors();
  const stack = shareCardFontStack();

  const INSET = 24;
  const PAD   = 76;
  const X     = INSET + PAD;                 // 100
  const RIGHT = SHARE_CARD_W - INSET - PAD;  // 1100
  const CW    = RIGHT - X;                   // 1000

  // Backdrop + surface.
  ctx.fillStyle = col.page;
  ctx.fillRect(0, 0, SHARE_CARD_W, SHARE_CARD_H);

  shareCardRoundRect(ctx, INSET, INSET, SHARE_CARD_W - INSET * 2, SHARE_CARD_H - INSET * 2, 14);
  ctx.fillStyle = col.surface;
  ctx.fill();

  // Accent stripe, clipped to the card's rounded left edge.
  ctx.save();
  ctx.clip();
  ctx.fillStyle = col.accent;
  ctx.fillRect(INSET, INSET, 8, SHARE_CARD_H - INSET * 2);
  ctx.restore();

  shareCardRoundRect(ctx, INSET + 0.5, INSET + 0.5, SHARE_CARD_W - INSET * 2 - 1, SHARE_CARD_H - INSET * 2 - 1, 14);
  ctx.strokeStyle = col.border;
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── Header ──────────────────────────────────────────────────
  shareCardDrawTracked(ctx, 'ARITHMETIC TRAINER', X, 100, 700, 20, stack, col.faint, 3.5);

  // ── Body blocks ─────────────────────────────────────────────
  const scoreText = Number.isFinite(data.score) ? String(data.score) : '—';
  const scoreLine = shareCardMeasure(ctx, scoreText, 700, 168, stack, CW);

  const subText = shareCardSubtitle(data);
  const subLine = subText ? shareCardMeasure(ctx, subText, 400, 36, stack, CW) : null;

  // percentilePercent() (js/util.js) already decided whether this figure is
  // worth saying at all; null here means the population was too thin, and the
  // card says nothing rather than shipping a hedge into somebody's Discord.
  const pct = Number.isFinite(Number(data.percentile)) && data.percentile !== null
    ? Number(data.percentile)
    : null;
  const pctLine = pct === null
    ? null
    : shareCardMeasure(ctx, `Faster than ${pct}% of players`, 700, 30, stack, CW);

  const opStats = (data.opStats || []).filter(o => Number.isFinite(o.avgMs) && o.avgMs > 0).slice(0, 4);

  const GAP_SUB   = 16;
  const GAP_PCT   = 20;
  const GAP_RULE  = 32;
  const OP_GLYPH_BASE = 31;   // glyph baseline, relative to the op block top
  const OP_VALUE_BASE = 66;   // avg-time baseline, same origin
  const OP_BLOCK_H    = 72;

  let bodyH = scoreLine.ascent;
  if (subLine) bodyH += GAP_SUB + subLine.ascent;
  if (pctLine) bodyH += GAP_PCT + pctLine.ascent;
  if (opStats.length) bodyH += GAP_RULE + 1 + GAP_RULE + OP_BLOCK_H;

  const BODY_TOP    = 138;
  const BODY_BOTTOM = 530;
  let y = BODY_TOP + Math.max(0, (BODY_BOTTOM - BODY_TOP - bodyH) / 2);

  y += scoreLine.ascent;
  shareCardDrawLine(ctx, scoreLine, X, y, col.max, stack);

  if (subLine) {
    y += GAP_SUB + subLine.ascent;
    shareCardDrawLine(ctx, subLine, X, y, col.body, stack);
  }

  if (pctLine) {
    y += GAP_PCT + pctLine.ascent;
    shareCardDrawLine(ctx, pctLine, X, y, col.accent, stack);
  }

  if (opStats.length) {
    y += GAP_RULE;
    ctx.fillStyle = col.rule;
    ctx.fillRect(X, Math.round(y) + 0.5, CW, 1);
    y += 1 + GAP_RULE;

    const colW = CW / opStats.length;
    opStats.forEach((op, i) => {
      const cx    = X + colW * i;
      const glyph = SHARE_OP_GLYPH[op.name] || op.name.slice(0, 1).toUpperCase();
      const value = `${(op.avgMs / 1000).toFixed(2)}s avg`;

      const gl = shareCardMeasure(ctx, glyph, 700, 42, stack, colW - 16);
      shareCardDrawLine(ctx, gl, cx, y + OP_GLYPH_BASE, col.strong, stack);

      const vl = shareCardMeasure(ctx, value, 400, 26, stack, colW - 16);
      shareCardDrawLine(ctx, vl, cx, y + OP_VALUE_BASE, col.muted, stack);
    });
  }

  // ── Footer ──────────────────────────────────────────────────
  const FOOT = 562;
  const url  = shareCardSiteUrl();
  const urlLine = shareCardMeasure(ctx, url, 400, 22, stack, CW * 0.5);
  shareCardDrawLine(ctx, urlLine, RIGHT, FOOT, col.faint, stack, 'right');

  // Anonymous players simply have no name here — no placeholder, no "@", no
  // empty label sitting in the corner of the image.
  if (data.username) {
    const nameLine = shareCardMeasure(ctx, `@${data.username}`, 700, 24, stack, CW - urlLine.width - 40);
    shareCardDrawLine(ctx, nameLine, X, FOOT, col.soft, stack);
  }

  return canvas;
}

// ── Export ────────────────────────────────────────────────────

// Writing an image to the clipboard is unavailable in several situations that
// real players are actually in: any plain-http page (isSecureContext false),
// Firefox (no ClipboardItem image write by default), and Safari before 13.1.
// Detecting up front means the fallback is chosen deliberately rather than
// after a rejection the user has already waited on.
function shareCardCanCopyImage() {
  try {
    return !!(window.isSecureContext
      && navigator.clipboard
      && typeof navigator.clipboard.write === 'function'
      && typeof window.ClipboardItem === 'function');
  } catch (_) {
    return false;
  }
}

function shareCardDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.rel      = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked, but not immediately: the download is still being handed to the
  // browser when click() returns, and revoking synchronously cancels it.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Resolves to 'copied' or 'downloaded'. Rejects only when the PNG itself
// could not be produced — a clipboard refusal is a fallback, not a failure.
async function exportShareCard(canvas, filename) {
  const blobPromise = new Promise((resolve, reject) => {
    try {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob produced no blob')), 'image/png');
    } catch (e) {
      reject(e);
    }
  });
  // Both consumers below are conditional, and an unconsumed rejection here
  // would surface as an unhandled promise rejection in the console.
  blobPromise.catch(() => {});

  if (shareCardCanCopyImage()) {
    try {
      // The promise form, not an awaited blob: Safari requires the
      // ClipboardItem to be constructed inside the user-gesture task, and
      // awaiting toBlob first puts it outside.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      return 'copied';
    } catch (e) {
      console.warn('share card: clipboard image write failed, falling back to download:', e);
    }
  }

  shareCardDownload(await blobPromise, filename);
  return 'downloaded';
}

// ── Wiring ────────────────────────────────────────────────────

function shareCardSetStatus(el, text, cls, clearAfter) {
  if (!el) return;
  if (el._shareCardTimer) { clearTimeout(el._shareCardTimer); el._shareCardTimer = null; }
  el.textContent = text;
  el.className = 'share-card-status' + (cls ? ' ' + cls : '');
  if (clearAfter) {
    el._shareCardTimer = setTimeout(() => {
      el.textContent = '';
      el.className = 'share-card-status';
    }, clearAfter);
  }
}

// `getData` is called on click, not now, so the card always reflects whatever
// the page has resolved by then — the percentile in particular arrives from a
// network round trip well after the button exists.
function wireShareCardButton(btn, statusEl, getData) {
  if (!btn || typeof getData !== 'function') return;
  const label = btn.textContent;

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled    = true;
    btn.textContent = 'Working…';
    shareCardSetStatus(statusEl, '');

    let outcome = 'failed';
    try {
      const data   = getData();
      const canvas = renderShareCard(data);
      outcome = await exportShareCard(canvas, shareCardFilename(data));
    } catch (e) {
      console.warn('share card failed:', e);
    }

    btn.disabled    = false;
    btn.textContent = label;

    if (outcome === 'copied') {
      shareCardSetStatus(statusEl, 'Image copied — paste it into Discord, Slack or X.', 'is-ok', 6000);
    } else if (outcome === 'downloaded') {
      shareCardSetStatus(statusEl, "This browser can't copy images, so the PNG was downloaded instead.", 'is-ok', 9000);
    } else {
      shareCardSetStatus(statusEl, "Couldn't create the image — try again, or take a screenshot.", 'is-error');
    }
  });
}
