// test_practice.js — Node.js test for practice.js pure logic
// Run: node test_practice.js

let passed = 0, failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ── Paste pure helpers from practice.js ──────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseTwo(display, sep) {
  const parts = display.split(sep);
  return [parseInt(parts[0].trim(), 10), parseInt(parts[1].trim(), 10)];
}

function classifyMul(a, b) {
  if (a === b) return 'Squares';
  const lo = Math.min(a, b);
  if (lo >= 2 && lo <= 12) return `\u00d7${lo} tables`;
  return 'Large \u00d7 Large';
}

function classifyDiv(divisor, quotient) {
  if (divisor >= 2 && divisor <= 12) return `\u00f7${divisor}`;
  if (quotient >= 2 && quotient <= 12) return `\u00f7 large (\u00d7${quotient} factor)`;
  return 'Large \u00f7 Large';
}

function classifyAdd(a, b) {
  if (a === b) return 'Doubles';
  if (a >= 100 || b >= 100) return 'Triple-digit';
  if (a < 10 && b < 10) return 'Single + Single';
  if ((a < 10) !== (b < 10)) return 'Double + Single';
  // Both >= 10 from here
  if (Math.abs(a - b) <= 2) return 'Near-Doubles';
  const carry = ((a % 10) + (b % 10)) >= 10;
  return carry ? 'Double + Double, carry' : 'Double + Double, no carry';
}

function classifySub(minuend, subtrahend, answer) {
  if (answer <= 15) return 'Close Numbers';
  if (minuend >= 100) return 'Triple-digit';
  if (subtrahend % 10 <= 2 || subtrahend % 10 >= 8) return 'Round Subtrahend';
  const borrow = (minuend % 10) < (subtrahend % 10);
  return borrow ? 'Two-digit, borrow' : 'Two-digit, no borrow';
}

function classifyQuestion(q) {
  try {
    if (q.operation === 'multiplication') {
      const [a, b] = parseTwo(q.display, '\u00d7');
      return classifyMul(a, b);
    }
    if (q.operation === 'division') {
      const [, divisor] = parseTwo(q.display, '\u00f7');
      return classifyDiv(divisor, q.answer);
    }
    if (q.operation === 'addition') {
      const [a, b] = parseTwo(q.display, '+');
      return classifyAdd(a, b);
    }
    if (q.operation === 'subtraction') {
      const [minuend, subtrahend] = parseTwo(q.display, '\u2212');
      return classifySub(minuend, subtrahend, q.answer);
    }
  } catch (_) {}
  return 'Other';
}

function generateForCategory(operation, category) {
  if (operation === 'multiplication') {
    if (category === 'Squares') {
      const a = randInt(2, 15);
      return { display: `${a} \u00d7 ${a}`, answer: a * a, operation, category };
    }
    if (category.startsWith('\u00d7') && category.endsWith('tables')) {
      const factor = parseInt(category.slice(1));
      const other  = randInt(factor + 1, 100);
      const [a, b] = Math.random() < 0.5 ? [factor, other] : [other, factor];
      return { display: `${a} \u00d7 ${b}`, answer: factor * other, operation, category };
    }
    const la = randInt(13, 50), lb = randInt(13, 50);
    return { display: `${la} \u00d7 ${lb}`, answer: la * lb, operation, category };
  }
  if (operation === 'division') {
    if (category.startsWith('\u00f7') && !category.includes('large')) {
      const divisor  = parseInt(category.slice(1));
      const quotient = randInt(2, 12);
      return { display: `${divisor * quotient} \u00f7 ${divisor}`, answer: quotient, operation, category };
    }
    if (category.includes('large')) {
      const m      = category.match(/\u00d7(\d+)/);
      const factor  = m ? parseInt(m[1]) : randInt(2, 12);
      const divisor = randInt(13, 99);
      return { display: `${divisor * factor} \u00f7 ${divisor}`, answer: factor, operation, category };
    }
    const da = randInt(13, 50), db = randInt(13, 50);
    return { display: `${da * db} \u00f7 ${da}`, answer: db, operation, category };
  }
  if (operation === 'addition') {
    const [a, b] = genAddPair(category);
    return { display: `${a} + ${b}`, answer: a + b, operation, category };
  }
  if (operation === 'subtraction') {
    const [sum, sub, ans] = genSubPair(category);
    return { display: `${sum} \u2212 ${sub}`, answer: ans, operation, category };
  }
  const a = randInt(2, 50), b = randInt(2, 50);
  return { display: `${a} + ${b}`, answer: a + b, operation: 'addition', category };
}

function genAddPair(category) {
  for (let i = 0; i < 200; i++) {
    let a, b;
    switch (category) {
      case 'Doubles':
        a = randInt(2, 60); b = a; break;
      case 'Near-Doubles':
        a = randInt(2, 60); b = a + (Math.random() < 0.5 ? 1 : -1) * randInt(1, 2);
        if (b < 2) b = a + 1; break;
      case 'Single + Single':
        a = randInt(2, 9); b = randInt(2, 9); break;
      case 'Double + Single':
        a = randInt(10, 99); b = randInt(2, 9);
        if (Math.random() < 0.5) { const t = a; a = b; b = t; } break;
      case 'Double + Double, no carry':
        a = randInt(10, 89); b = randInt(10, 89); break;
      case 'Double + Double, carry':
        a = randInt(10, 89); b = randInt(10, 89); break;
      case 'Triple-digit':
        a = randInt(100, 200); b = randInt(2, 99);
        if (Math.random() < 0.5) { const t = a; a = b; b = t; } break;
      default:
        a = randInt(2, 100); b = randInt(2, 100); break;
    }
    if (classifyAdd(a, b) === category) return [a, b];
  }
  return [randInt(2, 50), randInt(2, 50)];
}

function genSubPair(category) {
  for (let i = 0; i < 200; i++) {
    let sub, sum;
    switch (category) {
      case 'Close Numbers':
        sub = randInt(10, 90);  sum = sub + randInt(2, 15); break;
      case 'Round Subtrahend': {
        const base = randInt(1, 9) * 10;
        sub = base + (Math.random() < 0.5 ? -randInt(1, 2) : randInt(1, 2));
        if (sub < 3) sub = base + 1;
        sum = sub + randInt(10, 80); break;
      }
      case 'Triple-digit':
        sub = randInt(10, 99);  sum = sub + randInt(100, 200); break;
      default:
        sub = randInt(11, 89);  sum = sub + randInt(10, 80); break;
    }
    const ans = sum - sub;
    if (ans > 0 && classifySub(sum, sub, ans) === category) return [sum, sub, ans];
  }
  return [60, 25, 35];
}

// Tip helpers
function getTip(q) {
  try {
    if (q.operation === 'multiplication') return getMultiplicationTip(q);
    if (q.operation === 'division')       return getDivisionTip(q);
    if (q.operation === 'addition')       return getAdditionTip(q);
    if (q.operation === 'subtraction')    return getSubtractionTip(q);
  } catch (_) {}
  return '';
}

function getMultiplicationTip(q) {
  const [a, b] = parseTwo(q.display, '\u00d7');
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const ans = q.answer;
  if (lo === 2)  return `Double: ${hi} + ${hi} = ${ans}`;
  if (lo === 3)  return `Double then add once more: ${hi}\u00d72 = ${hi*2}, + ${hi} = ${ans}`;
  if (lo === 4)  return `Double twice: ${hi} \u2192 ${hi*2} \u2192 ${ans}`;
  if (lo === 5)  return `\u00d75: multiply by 10 then halve: ${hi}\u00d710 = ${hi*10}, \u00f72 = ${ans}`;
  if (lo === 9)  return `\u00d79: ${hi}\u00d710 \u2212 ${hi}: ${hi*10} \u2212 ${hi} = ${ans}`;
  if (lo === 12) return `\u00d712: ${hi}\u00d710 + ${hi}\u00d72: ${hi*10} + ${hi*2} = ${ans}`;
  const tens = Math.floor(hi/10)*10, ones = hi%10;
  if (tens > 0 && ones > 0) return `Split: ${lo}\u00d7${tens} + ${lo}\u00d7${ones} = ${lo*tens} + ${lo*ones} = ${ans}`;
  return '';
}

function getDivisionTip(q) {
  const [a, b] = parseTwo(q.display, '\u00f7');
  const ans = q.answer;
  if (b === 2)  return `Halve: ${a} \u00f7 2 = ${ans}`;
  if (b === 5)  return `\u00f75: double then \u00f710: ${a}\u00d72 = ${a*2}, \u00f710 = ${ans}`;
  if (b === 10) return `Drop the last zero: ${a} \u00f7 10 = ${ans}`;
  if (b > 12) {
    if (ans === 5) return `${b}\u00d75 = ${a}`;
  }
  return `What \u00d7 ${b} = ${a}? \u2192 ${ans} \u00d7 ${b} = ${a}`;
}

function getAdditionTip(q) {
  const [a, b] = parseTwo(q.display, '+');
  const ans = q.answer;
  const diff = Math.abs(a - b);
  if (diff === 0) return `Doubles: ${a} + ${a} = ${ans}`;
  if (diff <= 2)  return `Near-doubles tip`;
  return '';
}

function getSubtractionTip(q) {
  const [a, b] = parseTwo(q.display, '\u2212');
  const ans = q.answer;
  if (ans <= 15) return `Count up: ${b} + ${ans} = ${a}`;
  return '';
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
console.log('\n13. Tips: non-empty strings for common cases');
assert('tip: 7×45',  typeof getTip({ operation: 'multiplication', display: '7 \u00d7 45', answer: 315 }) === 'string');
assert('tip: 315÷7', typeof getTip({ operation: 'division',       display: '315 \u00f7 7',  answer: 45  }) === 'string');
assert('tip: 27+34', typeof getTip({ operation: 'addition',       display: '27 + 34',       answer: 61  }) === 'string');
assert('tip: 75−29', typeof getTip({ operation: 'subtraction',    display: '75 \u2212 29',   answer: 46  }) === 'string');

// Spot-check specific tip content
const t1 = getTip({ operation: 'multiplication', display: '2 \u00d7 47', answer: 94 });
assert('tip ×2: mentions double', t1.toLowerCase().includes('double'), `got: "${t1}"`);

const t2 = getTip({ operation: 'multiplication', display: '9 \u00d7 13', answer: 117 });
assert('tip ×9: mentions ×10', t2.includes('10'), `got: "${t2}"`);

const t3 = getTip({ operation: 'division', display: '80 \u00f7 2', answer: 40 });
assert('tip ÷2: mentions halve', t3.toLowerCase().includes('halve'), `got: "${t3}"`);

const t4 = getTip({ operation: 'subtraction', display: '32 \u2212 27', answer: 5 });
assert('tip close sub: mentions count up', t4.toLowerCase().includes('count up'), `got: "${t4}"`);

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
