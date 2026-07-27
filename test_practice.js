// test_practice.js — Node.js tests for the pure logic in practice.js and tips.js
// Run: node test_practice.js
//
// These load the REAL source files into a sandbox rather than working from
// pasted copies. The previous version duplicated the helpers into this file,
// so the classifier tests could drift out of sync silently and the tip
// assertions were checking stubs defined here, not the shipped tips.

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

// Report one line per group instead of per assertion; large sampling loops
// used to emit thousands of ✓ lines and bury everything else.
function group(name, fn) {
  const before = failed;
  console.log(`\n${name}`);
  fn();
  const bad = failed - before;
  console.log(`  ${bad === 0 ? '✓ all passed' : `✗ ${bad} failed`}`);
}

// ── Load the real sources ────────────────────────────────────
// practice.js registers a DOMContentLoaded handler at the top level and
// touches localStorage; everything else it does lives inside functions. A
// couple of stubs are enough to evaluate it and reach the pure logic.
const sandbox = {
  console,
  document: { addEventListener() {} },
  localStorage: {
    length: 0,
    key() { return null; },
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  },
  currentUser: null,
  performance: { now: () => 0 },
  Math, JSON, Date, parseInt, parseFloat, String, Number, Array, Object, Set, isFinite, NaN,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const file of ['js/util.js', 'js/tips.js', 'js/practice.js']) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  vm.runInContext(src, sandbox, { filename: file });
}

const {
  randInt, parseTwo,
  classifyMul, classifyDiv, classifyAdd, classifySub, classifyQuestion,
  generateForCategory, genAddPair, genSubPair,
  getTip, getMultiplicationTip, getDivisionTip, getAdditionTip, getSubtractionTip,
  categoryWeight, pickWeightedKey,
} = sandbox;

// categoryStats is a top-level `let` in practice.js. In a vm context that is a
// global *lexical* binding, not a property of the sandbox object, so it has to
// be assigned by evaluating in the same context.
function setCategoryStats(obj) {
  sandbox.__seed = obj;
  vm.runInContext('categoryStats = __seed;', sandbox);
}

// Fail loudly if a rename in the sources silently drops something under test.
for (const [name, fn] of Object.entries({
  randInt, parseTwo, classifyMul, classifyDiv, classifyAdd, classifySub,
  classifyQuestion, generateForCategory, getTip, categoryWeight, pickWeightedKey,
})) {
  if (typeof fn !== 'function') {
    console.error(`FATAL: ${name} was not found in the loaded sources.`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

// ── 1. randInt ───────────────────────────────────────────────
console.log('\n1. randInt');
for (let i = 0; i < 1000; i++) {
  const v = randInt(3, 7);
  assert(`randInt(3,7) in range (sample ${i+1}/1000)`, v >= 3 && v <= 7, `got ${v}`);
  if (v < 3 || v > 7) break; // stop spamming on failure
}
// Check all values reachable
{
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(randInt(1, 5));
  assert('randInt(1,5) can produce all values 1-5', [1,2,3,4,5].every(n => seen.has(n)));
}

// ── 2. parseTwo ──────────────────────────────────────────────
console.log('\n2. parseTwo');
assert('parse multiplication', JSON.stringify(parseTwo('7 \u00d7 45', '\u00d7')) === '[7,45]');
assert('parse division',       JSON.stringify(parseTwo('315 \u00f7 7', '\u00f7')) === '[315,7]');
assert('parse addition',       JSON.stringify(parseTwo('45 + 67', '+')) === '[45,67]');
assert('parse subtraction',    JSON.stringify(parseTwo('112 \u2212 45', '\u2212')) === '[112,45]');
assert('parse leading space',  parseTwo(' 8 \u00d7 9 ', '\u00d7')[0] === 8);

// ── 3. classifyMul ──────────────────────────────────────────
console.log('\n3. classifyMul');
assert('Squares: 7×7',        classifyMul(7, 7)   === 'Squares');
assert('Squares: 12×12',      classifyMul(12, 12) === 'Squares');
assert('Squares: 2×2',        classifyMul(2, 2)   === 'Squares');
assert('×7 tables: 7×45',     classifyMul(7, 45)  === '\u00d77 tables');
assert('×7 tables: 45×7',     classifyMul(45, 7)  === '\u00d77 tables', 'commutative');
assert('×2 tables: 2×99',     classifyMul(2, 99)  === '\u00d72 tables');
assert('×12 tables: 12×8',    classifyMul(12, 8)  === '\u00d78 tables', 'lo=8');
assert('Large×Large: 15×20',  classifyMul(15, 20) === 'Large \u00d7 Large');
assert('Large×Large: 13×13',  classifyMul(13, 13) === 'Squares', 'square takes priority');

// ── 4. classifyDiv ──────────────────────────────────────────
console.log('\n4. classifyDiv');
assert('÷7 (divisor=7)',         classifyDiv(7, 5)  === '\u00f77');
assert('÷2 (divisor=2)',         classifyDiv(2, 9)  === '\u00f72');
assert('÷12 (divisor=12)',       classifyDiv(12, 4) === '\u00f712');
assert('÷large ×5 factor',      classifyDiv(20, 5) === '\u00f7 large (\u00d75 factor)');
assert('÷large ×12 factor',     classifyDiv(50, 12) === '\u00f7 large (\u00d712 factor)');
assert('Large÷Large',           classifyDiv(25, 15) === 'Large \u00f7 Large');

// ── 5. classifyAdd ──────────────────────────────────────────
console.log('\n5. classifyAdd');
assert('Doubles: 7+7',                  classifyAdd(7, 7)   === 'Doubles');
assert('Doubles: 50+50',                classifyAdd(50, 50) === 'Doubles');
assert('Near-Doubles requires both>=10: 7+8 → Single+Single', classifyAdd(7, 8)   === 'Single + Single');
assert('Near-Doubles: 20+22',           classifyAdd(20, 22) === 'Near-Doubles');
assert('Single+Single: 3+4',            classifyAdd(3, 4)   === 'Single + Single');
assert('Single+Single: 9+9 → Doubles',  classifyAdd(9, 9)   === 'Doubles', 'equal takes priority');
assert('Double+Single: 15+4',           classifyAdd(15, 4)  === 'Double + Single');
assert('Double+Single: 4+15',           classifyAdd(4, 15)  === 'Double + Single');
assert('Double+Single: 9+10',           classifyAdd(9, 10)  === 'Double + Single', '9<10 qualifies as single');
assert('Near-Doubles only when both>=10: 20+22', classifyAdd(20, 22) === 'Near-Doubles');
assert('DD no carry: 21+34',            classifyAdd(21, 34) === 'Double + Double, no carry', '1+4=5<10');
assert('DD carry: 27+34',               classifyAdd(27, 34) === 'Double + Double, carry', '7+4=11>=10');
assert('Triple-digit: 150+20',          classifyAdd(150, 20) === 'Triple-digit');
assert('Triple-digit: 20+150',          classifyAdd(20, 150) === 'Triple-digit');

// ── 6. classifySub ──────────────────────────────────────────
console.log('\n6. classifySub');
assert('Close Numbers: ans=10',         classifySub(50, 40, 10)  === 'Close Numbers');
assert('Close Numbers: ans=15',         classifySub(30, 15, 15)  === 'Close Numbers');
assert('Triple-digit: min=150',         classifySub(150, 30, 120) === 'Triple-digit');
assert('Round Subtrahend: sub=29',      classifySub(75, 29, 46)  === 'Round Subtrahend', '29%10=9>=8');
assert('Round Subtrahend: sub=31',      classifySub(75, 31, 44)  === 'Round Subtrahend', '31%10=1<=2');
assert('Round Subtrahend: sub=20',      classifySub(75, 20, 55)  === 'Round Subtrahend', '20%10=0<=2');
assert('Two-digit no borrow: 75-33',    classifySub(75, 33, 42)  === 'Two-digit, no borrow', '33%10=3, not round; 5>=3');
assert('Two-digit borrow: 72-35',       classifySub(72, 35, 37)  === 'Two-digit, borrow', '2<5');

// ── 7. classifyQuestion (full roundtrip parsing) ─────────────
console.log('\n7. classifyQuestion');
assert('mul question: 7×45',
  classifyQuestion({ operation: 'multiplication', display: '7 \u00d7 45', answer: 315 }) === '\u00d77 tables');
assert('mul question: Squares 8×8',
  classifyQuestion({ operation: 'multiplication', display: '8 \u00d7 8', answer: 64 }) === 'Squares');
assert('div question: 315÷7',
  classifyQuestion({ operation: 'division', display: '315 \u00f7 7', answer: 45 }) === '\u00f77');
assert('div question: 315÷45 (÷large)',
  classifyQuestion({ operation: 'division', display: '315 \u00f7 45', answer: 7 }) === '\u00f7 large (\u00d77 factor)');
assert('add question: 27+34 carry',
  classifyQuestion({ operation: 'addition', display: '27 + 34', answer: 61 }) === 'Double + Double, carry');
assert('sub question: 75−29 round',
  classifyQuestion({ operation: 'subtraction', display: '75 \u2212 29', answer: 46 }) === 'Round Subtrahend');
assert('unknown operation',
  classifyQuestion({ operation: 'unknown', display: '1+1', answer: 2 }) === 'Other');

// ── 8. generateForCategory — answer correctness ─────────────
console.log('\n8. generateForCategory answer correctness (20 samples each)');

const CATEGORIES = {
  multiplication: ['Squares', '\u00d72 tables', '\u00d77 tables', '\u00d712 tables', 'Large \u00d7 Large'],
  division:       ['\u00f72', '\u00f77', '\u00f7 large (\u00d75 factor)', 'Large \u00f7 Large'],
  addition:       ['Doubles', 'Near-Doubles', 'Single + Single', 'Double + Single',
                   'Double + Double, no carry', 'Double + Double, carry', 'Triple-digit'],
  subtraction:    ['Close Numbers', 'Round Subtrahend', 'Triple-digit',
                   'Two-digit, no borrow', 'Two-digit, borrow'],
};

for (const [op, cats] of Object.entries(CATEGORIES)) {
  for (const cat of cats) {
    let allCorrect = true, allClassify = true;
    for (let i = 0; i < 20; i++) {
      const q = generateForCategory(op, cat);
      // Check answer is a valid integer
      if (!Number.isInteger(q.answer) || q.answer <= 0) { allCorrect = false; break; }
      // For mul/div: verify arithmetic
      if (op === 'multiplication') {
        const [a, b] = parseTwo(q.display, '\u00d7');
        if (a * b !== q.answer) { allCorrect = false; break; }
      }
      if (op === 'division') {
        const [dividend, divisor] = parseTwo(q.display, '\u00f7');
        if (dividend / divisor !== q.answer) { allCorrect = false; break; }
      }
      if (op === 'addition') {
        const [a, b] = parseTwo(q.display, '+');
        if (a + b !== q.answer) { allCorrect = false; break; }
      }
      if (op === 'subtraction') {
        const [a, b] = parseTwo(q.display, '\u2212');
        if (a - b !== q.answer) { allCorrect = false; break; }
      }
      // Check no NaN in answer
      if (isNaN(q.answer)) { allCorrect = false; break; }
    }
    assert(`${op} / ${cat}: answers correct`, allCorrect);
  }
}

// ── 9. Roundtrip: generated questions classify to intended cat ─
console.log('\n9. Roundtrip: generateForCategory → classifyQuestion (50 samples each)');

const ROUNDTRIP = {
  multiplication: ['Squares', '\u00d72 tables', '\u00d75 tables', '\u00d77 tables', '\u00d79 tables', '\u00d712 tables'],
  division:       ['\u00f72', '\u00f75', '\u00f77', '\u00f712'],
  addition:       ['Doubles', 'Near-Doubles', 'Single + Single', 'Double + Single',
                   'Double + Double, no carry', 'Double + Double, carry'],
  subtraction:    ['Close Numbers', 'Round Subtrahend', 'Two-digit, no borrow', 'Two-digit, borrow'],
};

for (const [op, cats] of Object.entries(ROUNDTRIP)) {
  for (const cat of cats) {
    let mismatches = 0;
    const examples = [];
    for (let i = 0; i < 50; i++) {
      const q = generateForCategory(op, cat);
      const got = classifyQuestion(q);
      if (got !== cat) {
        mismatches++;
        if (examples.length < 2) examples.push(`"${q.display}" → "${got}" (expected "${cat}")`);
      }
    }
    assert(
      `${op} / ${cat}: roundtrip (${50 - mismatches}/50)`,
      mismatches === 0,
      examples.join('; ')
    );
  }
}

// ── 10. Division: no remainder ───────────────────────────────
console.log('\n10. Division: generated questions are always exact (no remainder)');
for (const cat of ['\u00f72', '\u00f73', '\u00f75', '\u00f77', '\u00f712',
                   '\u00f7 large (\u00d75 factor)', '\u00f7 large (\u00d77 factor)', 'Large \u00f7 Large']) {
  let clean = true;
  for (let i = 0; i < 30; i++) {
    const q = generateForCategory('division', cat);
    const [dividend, divisor] = parseTwo(q.display, '\u00f7');
    if (dividend % divisor !== 0) { clean = false; break; }
  }
  assert(`division / ${cat}: always exact`, clean);
}

// ── 11. Subtraction: answer always positive ──────────────────
console.log('\n11. Subtraction: answer always positive');
for (const cat of ['Close Numbers', 'Round Subtrahend', 'Triple-digit', 'Two-digit, no borrow', 'Two-digit, borrow']) {
  let ok = true;
  for (let i = 0; i < 50; i++) {
    const q = generateForCategory('subtraction', cat);
    if (q.answer <= 0) { ok = false; break; }
  }
  assert(`subtraction / ${cat}: answer > 0`, ok);
}

// ── 12. Multiplication: display answer matches a×b ──────────
console.log('\n12. Multiplication: display answer == a×b');
for (const cat of ['Squares', '\u00d72 tables', '\u00d77 tables', '\u00d712 tables', 'Large \u00d7 Large']) {
  let ok = true;
  for (let i = 0; i < 30; i++) {
    const q = generateForCategory('multiplication', cat);
    const [a, b] = parseTwo(q.display, '\u00d7');
    if (a * b !== q.answer) { ok = false; break; }
  }
  assert(`multiplication / ${cat}: a×b === answer`, ok);
}

// ── 13. Tips: return strings for known question types ────────
console.log('\n13. Tips: arithmetic correctness and coverage');

// Every tip states worked numbers. Rather than checking for keywords, pull the
// arithmetic claims back out of the string and verify they are actually true:
// a tip that says "5×20 = 90" is worse than no tip at all.
function checkTipArithmetic(label, q) {
  const tip = getTip(q);
  assert(`${label}: returns a string`, typeof tip === 'string', `got ${typeof tip}`);
  if (!tip) return tip;

  // Tips chain their working ("5×10 − 5 = 50 − 5 = 45"), so individual
  // sub-expressions can't be pulled out reliably. What must always hold is
  // that the line ENDS on a true value: either the answer, or — for the
  // "recall the multiplication" style tips that work backwards — one of the
  // operands from the display.
  const nums = tip.match(/\d+/g);
  if (!nums) return tip;
  const last = +nums[nums.length - 1];
  const sep = q.operation === 'multiplication' ? '×'
            : q.operation === 'division'       ? '÷'
            : q.operation === 'addition'       ? '+' : '−';
  const [x, y] = parseTwo(q.display, sep);
  const acceptable = [q.answer, x, y].filter(v => Number.isFinite(v));
  assert(`${label}: tip resolves to a real value`, acceptable.includes(last),
    `tip ended on ${last}, expected one of ${acceptable.join('/')} — "${tip}"`);
  return tip;
}

// Sweep every generated category and check both correctness and how often a
// tip comes back empty. Categories that used to go silent: "Double + Single"
// (~35% empty), "Large x Large" (~13%), "Single + Single" (~12%).
const TIP_CATEGORIES = [
  ['multiplication', 'Squares'], ['multiplication', '×2 tables'], ['multiplication', '×7 tables'],
  ['multiplication', '×11 tables'], ['multiplication', '×12 tables'], ['multiplication', 'Large × Large'],
  ['division', '÷2'], ['division', '÷7'], ['division', '÷9'],
  ['division', '÷ large (×10 factor)'], ['division', 'Large ÷ Large'],
  ['addition', 'Doubles'], ['addition', 'Near-Doubles'], ['addition', 'Single + Single'],
  ['addition', 'Double + Single'], ['addition', 'Double + Double, carry'],
  ['addition', 'Double + Double, no carry'], ['addition', 'Triple-digit'],
  ['subtraction', 'Close Numbers'], ['subtraction', 'Round Subtrahend'],
  ['subtraction', 'Two-digit, borrow'], ['subtraction', 'Two-digit, no borrow'],
  ['subtraction', 'Triple-digit'],
];

const SAMPLES = 200;
const emptyReport = [];
for (const [op, cat] of TIP_CATEGORIES) {
  let empty = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const q = generateForCategory(op, cat);
    const tip = checkTipArithmetic(`${op}/${cat}`, q);
    if (!tip) empty++;
  }
  const pct = Math.round(empty / SAMPLES * 100);
  if (pct > 0) emptyReport.push(`${op}/${cat}: ${pct}% empty`);
  assert(`tip coverage ${op}/${cat} (${pct}% empty)`, pct <= 5,
    `${empty}/${SAMPLES} generated questions produced no tip`);
}
if (emptyReport.length) console.log('  note — categories still returning empty tips: ' + emptyReport.join(', '));

// Specific tricks still say what they should.
assert('tip ×2 mentions double',
  getMultiplicationTip({ operation: 'multiplication', display: '2 × 47', answer: 94 }).toLowerCase().includes('double'));
assert('tip ×9 uses the ×10 shortcut',
  getMultiplicationTip({ operation: 'multiplication', display: '9 × 13', answer: 117 }).includes('10'));
assert('tip ÷2 mentions halve',
  getDivisionTip({ operation: 'division', display: '80 ÷ 2', answer: 40 }).toLowerCase().includes('halve'));
assert('tip for close subtraction counts up',
  getSubtractionTip({ operation: 'subtraction', display: '32 − 27', answer: 5 }).toLowerCase().includes('count up'));

// The ×11 digit-sandwich trick, including the carry case.
assert('×11 sandwich without carry (11×35=385)',
  getMultiplicationTip({ operation: 'multiplication', display: '11 × 35', answer: 385 }).includes('3|8|5'));
assert('×11 sandwich with carry (11×87=957)',
  getMultiplicationTip({ operation: 'multiplication', display: '11 × 87', answer: 957 }).includes('9|5|7'));
assert('×11 sandwich with carry (11×99=1089)',
  getMultiplicationTip({ operation: 'multiplication', display: '11 × 99', answer: 1089 }).includes('10|8|9'));

// Regressions this pass fixed.
assert('round-ten × round-ten gets a tip (20×30)',
  getMultiplicationTip({ operation: 'multiplication', display: '20 × 30', answer: 600 }) !== '');
assert('single + double-digit gets a tip (5 + 90)',
  getAdditionTip({ operation: 'addition', display: '5 + 90', answer: 95 }) !== '');
assert('quotient of 10 gets a tip (250 ÷ 25)',
  getDivisionTip({ operation: 'division', display: '250 ÷ 25', answer: 10 }) !== '');
assert('round subtrahend avoids the "− 0" noise (75 − 30)',
  !/−\s*0\b/.test(getSubtractionTip({ operation: 'subtraction', display: '75 − 30', answer: 45 })),
  getSubtractionTip({ operation: 'subtraction', display: '75 − 30', answer: 45 }));

// ── 13b. Adaptive selection ──────────────────────────────────
console.log('\n13b. Adaptive category weighting');
{
  // categoryWeight reads the module-level categoryStats, so seed it.
  const seed = {
    'multiplication|fast': { operation: 'multiplication', category: 'fast', count: 40, totalMs: 40 * 600,  mistakes: 0 },
    'division|slow':       { operation: 'division',       category: 'slow', count: 40, totalMs: 40 * 5200, mistakes: 20 },
  };
  setCategoryStats(seed);
  const wFast = categoryWeight('multiplication|fast', {});
  const wSlow = categoryWeight('division|slow', {});
  assert('slow + error-prone category outweighs the fast clean one', wSlow > wFast * 3,
    `fast=${wFast.toFixed(2)} slow=${wSlow.toFixed(2)}`);
  assert('an unseen category gets neutral weight', categoryWeight('addition|never-seen', {}) === 1);

  // Weights are bounded so one category cannot take over completely.
  seed['division|awful'] =
    { operation: 'division', category: 'awful', count: 10, totalMs: 10 * 60000, mistakes: 10 };
  setCategoryStats(seed);
  assert('weight is capped for pathological categories', categoryWeight('division|awful', {}) <= 9,
    `got ${categoryWeight('division|awful', {})}`);

  // The draw honours the weights and still returns every key sometimes.
  const keys = ['multiplication|fast', 'division|slow'];
  const counts = { 'multiplication|fast': 0, 'division|slow': 0 };
  for (let i = 0; i < 4000; i++) counts[pickWeightedKey(keys, {})]++;
  assert('weighted draw favours the weak category',
    counts['division|slow'] > counts['multiplication|fast'] * 2,
    JSON.stringify(counts));
  assert('weighted draw still surfaces the strong category sometimes',
    counts['multiplication|fast'] > 0, JSON.stringify(counts));

  // In-session results shift the weighting without touching history.
  const live = { 'multiplication|fast': { count: 30, totalMs: 30 * 9000, mistakes: 25 } };
  assert('a bad run in-session raises that category\'s weight',
    categoryWeight('multiplication|fast', live) > wFast,
    `was ${wFast.toFixed(2)}, now ${categoryWeight('multiplication|fast', live).toFixed(2)}`);
  setCategoryStats({});
}

// ── 14. Edge cases ───────────────────────────────────────────
console.log('\n14. Edge cases');
assert('classifyAdd: Doubles beats Near-Doubles', classifyAdd(5, 5) === 'Doubles');
assert('classifyAdd: 9+10 = Double+Single',        classifyAdd(9, 10) === 'Double + Single', '9 is single-digit; Near-Doubles only for both>=10');
assert('classifyMul: symmetric',                   classifyMul(3, 45) === classifyMul(45, 3));
assert('generateForCategory: unknown op → addition fallback',
  generateForCategory('badop', 'whatever').operation === 'addition');
assert('classifyQuestion: bad display → Other',
  classifyQuestion({ operation: 'multiplication', display: 'broken', answer: 1 }) === 'Other');
assert('randInt single value: randInt(5,5) === 5', randInt(5,5) === 5);

// ── Results ──────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} assertions`);
if (failed === 0) {
  console.log('All tests passed!');
} else {
  console.log(`${failed} test(s) FAILED — see ✗ lines above`);
  process.exit(1);
}
