// The client rule must agree with the database CHECK on profiles.username:
//   username ~ '^[A-Za-z0-9_-]{3,20}$' AND octet_length = char_length
import vm from 'node:vm';
import fs from 'node:fs';
const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync('js/util.js','utf8'), ctx);
const problem = (v) => vm.runInContext(`usernameProblem(${JSON.stringify(v)})`, ctx);

// Mirror of the SQL predicate, evaluated on the trimmed value the client sends.
const dbAccepts = (v) => {
  const s = String(v ?? '').trim();
  return /^[A-Za-z0-9_-]{3,20}$/.test(s) && Buffer.byteLength(s,'utf8') === s.length;
};

const CASES = [
  'yangyang','yang_z','a-b-c','abc','ABC123','x'.repeat(20),
  '', '  ', 'ab', 'x'.repeat(21), 'Yang Yang', 'yang yang',
  'yángyang', 'уangyang', 'yang😀', 'yang.z', 'yang@z', 'yang/z',
  '  yangyang  ', 'yang\tz', '---', '___', '1', '12',
];
let pass=0, fail=0;
for (const c of CASES) {
  const clientOk = problem(c) === null;
  const dbOk = dbAccepts(c);
  if (clientOk === dbOk) { pass++; }
  else { fail++; console.log(`  MISMATCH ${JSON.stringify(c)}: client=${clientOk?'accept':'reject'} db=${dbOk?'accept':'reject'} (${problem(c)})`); }
}
// The messages must be specific enough to act on.
const spaceMsg = problem('Yang Yang');
if (!/space/i.test(spaceMsg)) { fail++; console.log('  space case does not mention spaces:', spaceMsg); } else pass++;
const shortMsg = problem('ab');
if (!/3/.test(shortMsg)) { fail++; console.log('  short case does not state the minimum:', shortMsg); } else pass++;
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
