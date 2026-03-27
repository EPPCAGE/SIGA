const {execSync} = require('node:child_process');
const fs = require('node:fs');
const commits = ['fce1969','6c8d139','d67b600','a45d710','8109241','5d7d594','8bfb035','1695fc6','ce0272b'];

function checkCommit(commit) {
  const tmp = `check2_${commit}.html`;
  try {
    execSync(`git show ${commit}:index.html > "${tmp}"`, {cwd: process.cwd()});
    const html = fs.readFileSync(tmp, 'utf-8');
    const re = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/g;
    let m, biggest = '';
    while ((m = re.exec(html)) !== null) { if (m[1].length > biggest.length) biggest = m[1]; }
    try { new Function(biggest); return 'OK'; }
    catch(e) { return 'ERR: ' + e.message; }
  } catch(e) {
    return 'FAIL: ' + e.message.split('\n')[0];
  } finally {
    try { fs.unlinkSync(tmp); } catch(e) { /* intentionally ignored */ }
  }
}

commits.forEach(c => console.log(c + ': ' + checkCommit(c)));
