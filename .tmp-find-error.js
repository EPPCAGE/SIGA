const fs = require('fs');
const src = fs.readFileSync('.tmp-current-script.js', 'utf8');
let i = 0, line = 1, state = 'code';
const stack = [];

while (i < src.length) {
  const ch = src[i];
  if (ch === '\n') { line++; i++; continue; }

  if (state === 'code') {
    if (ch === '/' && src[i+1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i+1] === '*') {
      i += 2;
      while (i < src.length && !(src[i-1] === '*' && src[i] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i++; continue;
    }
    if (ch === '`') { stack.push({type:'template', line}); state = 'template'; i++; continue; }
    if (ch === "'") { stack.push({type:'sq', line}); state = 'sq'; i++; continue; }
    if (ch === '"') { stack.push({type:'dq', line}); state = 'dq'; i++; continue; }
  } else if (state === 'template') {
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') { stack.pop(); state = 'code'; i++; continue; }
  } else if (state === 'sq') {
    if (ch === '\\') { i += 2; continue; }
    if (ch === "'") { stack.pop(); state = 'code'; i++; continue; }
    if (ch === '\n') { stack.pop(); state = 'code'; }
  } else if (state === 'dq') {
    if (ch === '\\') { i += 2; continue; }
    if (ch === '"') { stack.pop(); state = 'code'; i++; continue; }
    if (ch === '\n') { stack.pop(); state = 'code'; }
  }
  i++;
}

if (stack.length) {
  const item = stack[stack.length - 1];
  console.log('Unclosed ' + item.type + ' started at script line ' + item.line);
  console.log('(= index.html line ~' + (item.line + 4424) + ')');
  // Print surrounding lines
  const lines = src.split('\n');
  const start = Math.max(0, item.line - 3);
  const end = Math.min(lines.length, item.line + 3);
  for (let l = start; l < end; l++) {
    console.log('  ' + (l+1) + ': ' + lines[l].substring(0, 100));
  }
} else {
  console.log('No unclosed strings — may be bracket/paren mismatch');
}
