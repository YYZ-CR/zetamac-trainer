// ── Mental-math tips ──────────────────────────────────────────
// Single source of truth, shared by the results page and practice mode.
// These used to be duplicated verbatim in results.js and practice.js, with a
// third, divergent copy in test_practice.js.
//
// Every branch returns a fully worked line with the real numbers substituted,
// never a generic template. Returning '' is allowed and means "nothing useful
// to say here" — callers render nothing rather than filler.

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
  const [a, b] = parseTwo(q.display, '×');
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const ans = q.answer;

  // Tricks for each small multiplier (default config mulMin1=2, mulMax1=12)
  if (lo === 2)  return `Double: ${hi} + ${hi} = ${ans}`;
  if (lo === 3)  return `Double then add once more: ${hi}×2 = ${hi * 2}, + ${hi} = ${ans}`;
  if (lo === 4)  return `Double twice: ${hi} → ${hi * 2} → ${ans}`;
  if (lo === 5)  return `×5: multiply by 10 then halve: ${hi}×10 = ${hi * 10}, ÷2 = ${ans}`;
  if (lo === 6)  return `×6: 5×${hi} + ${hi}: ${hi * 5} + ${hi} = ${ans}`;
  if (lo === 7)  return `×7: ${hi}×10 − ${hi}×3: ${hi * 10} − ${hi * 3} = ${ans}`;
  if (lo === 8)  return `×8: double three times: ${hi} → ${hi * 2} → ${hi * 4} → ${ans}`;
  if (lo === 9)  return `×9: ${hi}×10 − ${hi}: ${hi * 10} − ${hi} = ${ans}`;
  if (lo === 10) return `Append a zero: ${hi}×10 = ${ans}`;

  if (lo === 11) {
    // Digit-sandwich trick for 2-digit numbers: 11 × AB = A(A+B)B
    if (hi >= 10 && hi <= 99) {
      const d1 = Math.floor(hi / 10), d2 = hi % 10, s = d1 + d2;
      if (s < 10)
        return `×11 trick: put digit-sum (${d1}+${d2}=${s}) between the digits: ${d1}|${s}|${d2} = ${ans}`;
      else
        return `×11 trick: digit-sum ${d1}+${d2}=${s} (carry 1): ${d1 + 1}|${s - 10}|${d2} = ${ans}`;
    }
    return `×11: ${hi}×10 + ${hi}: ${hi * 10} + ${hi} = ${ans}`;
  }

  if (lo === 12) return `×12: ${hi}×10 + ${hi}×2: ${hi * 10} + ${hi * 2} = ${ans}`;

  // Both factors are round tens: strip the zeros, multiply, put them back.
  // Without this, 20×30 fell through every branch and produced no tip at all.
  if (lo % 10 === 0 && hi % 10 === 0) {
    const l = lo / 10, h = hi / 10;
    return `Strip the zeros: ${l}×${h} = ${l * h}, then add two zeros → ${ans}`;
  }

  // One factor is a round ten: multiply by the tens digit, append the zero.
  if (hi % 10 === 0) {
    const h = hi / 10;
    return `${lo}×${hi}: ${lo}×${h} = ${lo * h}, then append a zero → ${ans}`;
  }
  if (lo % 10 === 0) {
    const l = lo / 10;
    return `${lo}×${hi}: ${l}×${hi} = ${l * hi}, then append a zero → ${ans}`;
  }

  // Round the larger factor to a multiple of 10 and compensate
  const roundHi = Math.round(hi / 10) * 10, diff = hi - roundHi;
  if (roundHi !== 0 && Math.abs(diff) <= 2 && diff !== 0) {
    const sign = diff > 0 ? '+' : '−';
    return `Round: ${lo}×${roundHi} = ${lo * roundHi}, ${sign} ${lo}×${Math.abs(diff)} = ${Math.abs(lo * diff)} → ${ans}`;
  }

  // Split the larger factor: lo×hi = lo×(tens + ones)
  const tens = Math.floor(hi / 10) * 10, ones = hi % 10;
  if (tens > 0 && ones > 0)
    return `Split: ${lo}×${tens} + ${lo}×${ones} = ${lo * tens} + ${lo * ones} = ${ans}`;

  // Both single digits and nothing above applied — squares are worth naming.
  if (lo === hi) return `${lo}² = ${ans}`;

  return `${lo}×${hi}: build from ${lo}×${hi - 1} = ${lo * (hi - 1)}, + ${lo} = ${ans}`;
}

function getDivisionTip(q) {
  const [a, b] = parseTwo(q.display, '÷');
  const ans = q.answer;

  // Small divisor tricks (b = 2–12)
  if (b === 2)  return `Halve: ${a} ÷ 2 = ${ans}`;
  if (b === 3)  return `Recall ×3 = double+add: ${ans}×2 = ${ans * 2}, + ${ans} = ${a}`;
  if (b === 4)  return `Halve twice: ${a} → ${a / 2} → ${ans}`;
  if (b === 5)  return `÷5: double then ÷10: ${a}×2 = ${a * 2}, ÷10 = ${ans}`;
  if (b === 6)  return `÷6: halve then ÷3: ${a} ÷ 2 = ${a / 2}, ÷ 3 = ${ans}`;
  if (b === 7)  return `Recall ×7 = ×10−×3: ${ans}×10 − ${ans}×3 = ${ans * 10} − ${ans * 3} = ${a}`;
  if (b === 8)  return `Halve three times: ${a} → ${a / 2} → ${a / 4} → ${ans}`;
  if (b === 9)  return `Recall ×9 = ×10−n: ${ans}×10 − ${ans} = ${ans * 10} − ${ans} = ${a}`;
  if (b === 10) return `Drop the last zero: ${a} ÷ 10 = ${ans}`;
  if (b === 11) return `Recall ×11 = ×10+n: ${ans}×10 + ${ans} = ${ans * 10} + ${ans} = ${a}`;
  if (b === 12) return `Recall ×12 = ×10+×2: ${ans}×10 + ${ans}×2 = ${ans * 10} + ${ans * 2} = ${a}`;

  // Large divisor (b > 12): the answer is the small factor, so flip the problem
  // and reach for that factor's multiplication trick.
  if (b > 12) {
    if (ans === 2)  return `${b}×2 = ${a} → just double ${b}: ${b} + ${b} = ${a}`;
    if (ans === 3)  return `${b}×3 = ${a} → double+add: ${b * 2} + ${b} = ${a}`;
    if (ans === 4)  return `${b}×4 = ${a} → double twice: ${b} → ${b * 2} → ${a}`;
    if (ans === 5)  return `${b}×5 = ${a} → ${b}×10÷2: ${b * 10}÷2 = ${a}`;
    if (ans === 6)  return `${b}×6 = ${a} → 5×${b} + ${b}: ${b * 5} + ${b} = ${a}`;
    if (ans === 7)  return `${b}×7 = ${a} → ${b}×10−${b}×3: ${b * 10}−${b * 3} = ${a}`;
    if (ans === 8)  return `${b}×8 = ${a} → double 3×: ${b}→${b * 2}→${b * 4}→${a}`;
    if (ans === 9)  return `${b}×9 = ${a} → ${b}×10−${b}: ${b * 10}−${b} = ${a}`;
    // ans === 10 used to fall straight through to the generic line.
    if (ans === 10) return `${b}×10 = ${a} → just append a zero to ${b}`;
    if (ans === 11) return `${b}×11 = ${a} → ${b}×10+${b}: ${b * 10}+${b} = ${a}`;
    if (ans === 12) return `${b}×12 = ${a} → ${b}×10+${b}×2: ${b * 10}+${b * 2} = ${a}`;
  }

  return `What × ${b} = ${a}? → ${ans} × ${b} = ${a}`;
}

function getAdditionTip(q) {
  const [a, b] = parseTwo(q.display, '+');
  const ans = q.answer;

  // Near-doubles: when both numbers are equal or differ by 1–2
  const diff = Math.abs(a - b);
  if (diff <= 2) {
    const smaller = Math.min(a, b);
    if (diff === 0) return `Doubles: ${a} + ${a} = ${ans}`;
    return `Near-doubles: ${smaller} + ${smaller} = ${smaller * 2}, + ${diff} = ${ans}`;
  }

  // Bridge through nearest multiple of 10: take from one addend to round the other
  const ceilA = Math.ceil(a / 10) * 10, toA = ceilA - a;
  if (toA > 0 && toA <= 4 && b >= toA)
    return `Bridge through ${ceilA}: ${a} + ${toA} = ${ceilA}, + ${b - toA} = ${ans}`;

  const ceilB = Math.ceil(b / 10) * 10, toB = ceilB - b;
  if (toB > 0 && toB <= 4 && a >= toB)
    return `Bridge through ${ceilB}: ${b} + ${toB} = ${ceilB}, + ${a - toB} = ${ans}`;

  // Round and compensate: round the near-10 addend, adjust the other
  const roundA = Math.round(a / 10) * 10, gapA = roundA - a; // positive = rounded up
  if (gapA >= 1 && gapA <= 4 && b >= gapA)
    return `Round ${a}→${roundA}: ${roundA} + ${b - gapA} = ${ans}`;

  const roundB = Math.round(b / 10) * 10, gapB = roundB - b;
  if (gapB >= 1 && gapB <= 4 && a >= gapB)
    return `Round ${b}→${roundB}: ${a - gapB} + ${roundB} = ${ans}`;

  // Left-to-right: add tens then ones
  const tensA = Math.floor(a / 10) * 10, onesA = a % 10;
  const tensB = Math.floor(b / 10) * 10, onesB = b % 10;
  if (tensA > 0 && tensB > 0) {
    const onesSum = onesA + onesB;
    if (onesSum >= 10)
      return `Left-to-right: ${tensA}+${tensB}=${tensA + tensB}, then ${onesA}+${onesB}=${onesSum} (carry 1) → ${ans}`;
    return `Left-to-right: ${tensA}+${tensB}=${tensA + tensB}, then +${onesSum} = ${ans}`;
  }

  // One addend is a single digit. This used to fall through with no tip at
  // all — roughly a third of "Double + Single" questions got nothing.
  const big = Math.max(a, b), small = Math.min(a, b);
  if (small < 10 && big >= 10) {
    const onesBig = big % 10;
    if (onesBig + small >= 10) {
      const toTen = 10 - onesBig;
      return `Bridge: ${big} + ${toTen} = ${big + toTen}, + ${small - toTen} = ${ans}`;
    }
    return `Add to the ones: ${big} has ${onesBig} ones, ${onesBig}+${small}=${onesBig + small} → ${ans}`;
  }

  // Both single digits.
  if (a < 10 && b < 10) {
    if (a + b >= 10) return `Make ten: ${big} + ${10 - big} = 10, + ${small - (10 - big)} = ${ans}`;
    return `${a} + ${b} = ${ans}`;
  }

  return '';
}

function getSubtractionTip(q) {
  // Display uses U+2212 (−) as minus sign
  const [a, b] = parseTwo(q.display, '−');
  const ans = q.answer;

  // Count up when the answer is small (the numbers are close)
  if (ans <= 15)
    return `Count up: ${b} + ${ans} = ${a}`;

  // Round subtrahend to nearest 10 and adjust.
  // diffB = b − roundB: negative means b was rounded UP (over-subtracted → add back)
  //                     positive means b was rounded DOWN (under-subtracted → subtract more)
  const roundB = Math.round(b / 10) * 10, diffB = b - roundB;
  if (Math.abs(diffB) <= 4 && diffB !== 0) {
    if (diffB < 0) {
      return `Round up: ${a} − ${roundB} = ${a - roundB}, add back ${Math.abs(diffB)} → ${ans}`;
    } else {
      return `Round down: ${a} − ${roundB} = ${a - roundB}, − ${diffB} more → ${ans}`;
    }
  }

  const tensA = Math.floor(a / 10) * 10, onesA = a % 10;
  const tensB = Math.floor(b / 10) * 10, onesB = b % 10;

  // Subtrahend is a round ten — nothing to fix up afterwards. The old code
  // still emitted the two-step form here, producing noise like "− 0 + 5".
  if (onesB === 0)
    return `Subtract the tens: ${a} − ${tensB} = ${ans}`;

  // No borrow needed: take tens then ones.
  if (onesA >= onesB)
    return `Left-to-right: ${tensA}−${tensB}=${tensA - tensB}, then +${onesA - onesB} → ${ans}`;

  // Borrow needed: subtract the whole tens first, then the ones.
  return `Left-to-right: ${a}−${tensB}=${a - tensB}, then −${onesB} → ${ans}`;
}
