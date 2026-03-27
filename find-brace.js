const fs = require('node:fs');
const code = fs.readFileSync('__main__.js', 'utf-8');
const lines = code.split('\n');

let b = 0, p = 0, bk = 0;
let inStr = false, strC = '', i = 0;

// Simple token-aware count
while (i < code.length) {
  const c = code[i];
  if (inStr) {
    if (c === '\\') { i += 2; continue; }
    if (c === strC) inStr = false;
  } else if (c === '/' && code[i+1] === '/') {
    while (i < code.length && code[i] !== '\n') i++;
    continue;
  } else if (c === '"' || c === "'" || c === '`') {
    inStr = true; strC = c;
  } else if (c === '{') b++;
  else if (c === '}') b--;
  else if (c === '(') p++;
  else if (c === ')') p--;
  else if (c === '[') bk++;
  else if (c === ']') bk--;
  i++;
}

console.log(`Final balance => braces: ${b}  parens: ${p}  brackets: ${bk}`);

// Find unclosed { by scanning backwards
if (b > 0) {
  console.log(`${b} unclosed { — scanning backwards to find first one:`);
  let b2 = 0;
  let found = 0;
  for (let j = lines.length - 1; j >= 0 && found < b; j--) {
    const l = lines[j];
    for (let k = l.length - 1; k >= 0; k--) {
      if (l[k] === '}') b2++;
      else if (l[k] === '{') {
        b2--;
        if (b2 < 0) {
          console.log(`  Unclosed { at line ${j+1}: ${l.substring(0, 120)}`);
          b2 = 0;
          found++;
        }
      }
    }
  }
}

if (p !== 0) console.log(`Paren imbalance: ${p}`);
if (bk !== 0) console.log(`Bracket imbalance: ${bk}`);
