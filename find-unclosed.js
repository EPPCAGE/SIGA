const fs = require('node:fs');
const code = fs.readFileSync('__main__.js', 'utf-8');
let i = 0;
const stack = []; // tracks open brackets/strings

function lineNum(pos) { return code.slice(0, pos).split('\n').length; }

while (i < code.length) {
  const c = code[i];
  const top = stack.at(-1);

  // Inside a single-quoted string
  if (top === "'") {
    if (c === '\\') { i += 2; continue; }
    if (c === "'") stack.pop();
    i++; continue;
  }
  // Inside a double-quoted string
  if (top === '"') {
    if (c === '\\') { i += 2; continue; }
    if (c === '"') stack.pop();
    i++; continue;
  }
  // Inside a template literal (not in expression)
  if (top === '`') {
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { stack.pop(); i++; continue; }
    if (c === '$' && code[i+1] === '{') {
      stack.push('${');
      i += 2; continue;
    }
    i++; continue;
  }
  // Skip line comments
  if (c === '/' && code[i+1] === '/') {
    while (i < code.length && code[i] !== '\n') i++;
    continue;
  }
  // Skip block comments
  if (c === '/' && code[i+1] === '*') {
    i += 2;
    while (i < code.length && !(code[i] === '*' && code[i+1] === '/')) i++;
    i += 2; continue;
  }
  // Normal code
  if (c === '"') { stack.push('"'); i++; continue; }
  if (c === "'") { stack.push("'"); i++; continue; }
  if (c === '`') { stack.push('`'); i++; continue; }
  if (c === '{') { stack.push('{'); i++; continue; }
  if (c === '(') { stack.push('('); i++; continue; }
  if (c === '[') { stack.push('['); i++; continue; }
  if (c === '}') {
    if (top === '${') { stack.pop(); }
    else if (top === '{') { stack.pop(); }
    else { console.log('Extra } at line ' + lineNum(i) + ': ' + code.split('\n')[lineNum(i)-1].substring(0,80)); }
    i++; continue;
  }
  if (c === ')') {
    if (top === '(') { stack.pop(); }
    else { console.log('Extra ) at line ' + lineNum(i) + ': ' + code.split('\n')[lineNum(i)-1].substring(0,80)); }
    i++; continue;
  }
  if (c === ']') {
    if (top === '[') { stack.pop(); }
    else { console.log('Extra ] at line ' + lineNum(i) + ': ' + code.split('\n')[lineNum(i)-1].substring(0,80)); }
    i++; continue;
  }
  i++;
}

console.log('\nEnd of file. Stack depth:', stack.length);
if (stack.length > 0) {
  console.log('Unclosed items (last 20):');
  stack.slice(-20).forEach(s => console.log('  ' + s));
}
