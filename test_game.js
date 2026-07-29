// test_game.js — Node.js tests for the question generator in js/game.js
// Run: node test_game.js
//
// Loads the REAL source into a sandbox, the same way test_practice.js does,
// so the assertions cannot drift away from the shipped generator.
//
// The contract under test is Zetamac's, not one of our own invention: a
// division question divides by the FIRST multiplication range and answers
// from the second. Under the default 2–12 × 2–100 that is the difference
// between "876 ÷ 12" and "876 ÷ 73"; the real game only ever asks the
// former, and the flipped form is a different skill.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function group(name, fn) {
  const before = failed;
  console.log(`\n${name}`);
  fn();
  const bad = failed - before;
  console.log(`  ${bad === 0 ? '✓ all passed' : `✗ ${bad} failed`}`);
}

// ── Load the real source ─────────────────────────────────────
// game.js registers a DOMContentLoaded handler at the top level; everything
// else it does lives inside functions, so a stub document is enough to reach
// generateQuestion().
const sandbox = {
  console,
  document: { addEventListener() {} },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  performance: { now: () => 0 },
  Math, JSON, Date, parseInt, parseFloat, String, Number, Array, Object, Set, isFinite, NaN,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/game.js'), 'utf8'),
                sandbox, { filename: 'js/game.js' });

const DIVIDE = '÷';
const TIMES  = '×';
const MINUS  = '−';

// The canonical Zetamac default.
const DEFAULT_CONFIG = {
  addMin1: 2, addMax1: 100, addMin2: 2, addMax2: 100,
  mulMin1: 2, mulMax1:  12, mulMin2: 2, mulMax2: 100,
  operations: ['addition', 'subtraction', 'multiplication', 'division'],
};

// `config` is a top-level `let`, so it lives in the script's lexical scope
// and not on the sandbox object — assigning sandbox.config would create a
// second, unrelated property. Set it by running an assignment inside the
// context instead.
function sample(n, cfg, ops) {
  sandbox.__cfg = { ...cfg, operations: ops };
  vm.runInContext('config = __cfg;', sandbox);
  return Array.from({ length: n }, () => sandbox.generateQuestion());
}

function operands(display, glyph) {
  const parts = display.split(' ' + glyph + ' ');
  return [Number(parts[0]), Number(parts[1])];
}

// ── Division: the divisor comes from the first range ─────────

group('division under the default config', () => {
  const qs = sample(3000, DEFAULT_CONFIG, ['division']);

  let divisorsInFirstRange = 0, exact = 0, correct = 0;
  const divisorsSeen = new Set(), quotientsSeen = new Set();

  for (const q of qs) {
    const [dividend, divisor] = operands(q.display, DIVIDE);
    if (divisor >= 2 && divisor <= 12) divisorsInFirstRange++;
    if (dividend % divisor === 0) exact++;
    if (dividend / divisor === q.answer) correct++;
    divisorsSeen.add(divisor);
    quotientsSeen.add(q.answer);
  }

  assert('every divisor is in the first multiplication range (2–12)',
    divisorsInFirstRange === qs.length,
    `${qs.length - divisorsInFirstRange} of ${qs.length} were outside it`);
  assert('every division is exact', exact === qs.length);
  assert('the stated answer is the real quotient', correct === qs.length);

  // The bug this file exists for produced divisors up to 100. Asserting the
  // range alone would also pass if the generator emitted "4 ÷ 2" forever, so
  // assert the spread too.
  assert('the whole 2–12 divisor range is used', divisorsSeen.size === 11,
    `saw ${divisorsSeen.size} distinct divisors: ${[...divisorsSeen].sort((a, b) => a - b).join(',')}`);
  assert('answers spread across the second range', quotientsSeen.size > 80,
    `saw ${quotientsSeen.size} distinct answers`);
});

group('division under an asymmetric custom config', () => {
  // Ranges chosen so the two are disjoint: any divisor above 5 proves the
  // generator drew from the wrong side.
  const cfg = { ...DEFAULT_CONFIG, mulMin1: 3, mulMax1: 5, mulMin2: 40, mulMax2: 60 };
  const qs = sample(1000, cfg, ['division']);

  let ok = 0;
  for (const q of qs) {
    const [, divisor] = operands(q.display, DIVIDE);
    if (divisor >= 3 && divisor <= 5 && q.answer >= 40 && q.answer <= 60) ok++;
  }
  assert('divisor from range 1, answer from range 2', ok === qs.length,
    `${qs.length - ok} of ${qs.length} were flipped`);
});

// ── The other three operations are unchanged ─────────────────

group('the other operations still hold their shape', () => {
  const mul = sample(500, DEFAULT_CONFIG, ['multiplication']);
  let ok = 0;
  for (const q of mul) {
    const [a, b] = operands(q.display, TIMES);
    if (a >= 2 && a <= 12 && b >= 2 && b <= 100 && a * b === q.answer) ok++;
  }
  assert('multiplication draws a from range 1 and b from range 2', ok === mul.length);

  const add = sample(500, DEFAULT_CONFIG, ['addition']);
  ok = 0;
  for (const q of add) {
    const [a, b] = operands(q.display, '+');
    if (a + b === q.answer) ok++;
  }
  assert('addition sums its two operands', ok === add.length);

  // Subtraction is still allowed to flip: it is presented as a reversed
  // addition and the default addition ranges are identical, so which operand
  // is subtracted is not observable the way the divisor is.
  const sub = sample(500, DEFAULT_CONFIG, ['subtraction']);
  ok = 0;
  for (const q of sub) {
    const [minuend, subtrahend] = operands(q.display, MINUS);
    if (minuend - subtrahend === q.answer && q.answer >= 2) ok++;
  }
  assert('subtraction never goes below the range floor', ok === sub.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
