const {execSync} = require('node:child_process');
const fs = require('node:fs');
const commits = ['HEAD','56a0e44','1cdc446','339e2ba','d569ddf'];

function checkCommit(commit) {
  const tmp = `check_${commit}.html`;
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
