const {execSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Lista todos os worktrees
const wtRaw = execSync('git worktree list --porcelain', {cwd: process.cwd()}).toString();
const worktrees = [];
let cur = {};
for (const line of wtRaw.split('\n')) {
  if (line.startsWith('worktree ')) { cur = {path: line.slice(9)}; }
  else if (line.startsWith('branch '))  { cur.branch = line.slice(7); worktrees.push({...cur}); }
  else if (line.includes('detached'))   { cur.branch = '(detached)'; worktrees.push({...cur}); }
}

const re = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/g;

for (const wt of worktrees) {
  const htmlPath = path.join(wt.path, 'index.html');
  if (!fs.existsSync(htmlPath)) { console.log(`${wt.branch}: NO FILE`); continue; }
  const html = fs.readFileSync(htmlPath, 'utf-8');
  re.lastIndex = 0;
  let m, biggest = '';
  while ((m = re.exec(html)) !== null) { if (m[1].length > biggest.length) biggest = m[1]; }
  try {
    new Function(biggest);
    console.log(`✅  ${wt.branch.padEnd(50)} OK   (${biggest.length} chars)`);
  } catch(e) {
    // binary search for line
    const lines = biggest.split('\n');
    let lo = 0, hi = lines.length;
    for (let iter = 0; iter < 25; iter++) {
      const mid = (lo + hi) >> 1;
      try { new Function(lines.slice(0, mid).join('\n')); hi = mid; }
      catch(e) { /* intentionally ignored for binary search */ lo = mid; }
    }
    console.log(`❌  ${wt.branch.padEnd(50)} ERR: ${e.message}  ~line ${lo}`);
  }
}
