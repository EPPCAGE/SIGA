'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const TEXT_EXTENSIONS = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.csv', '.svg',
]);
const IGNORE_DIRS = new Set([
  '.git', '.claude', 'node_modules', 'coverage', 'backups',
]);
const IGNORE_FILES = new Set([
  'data/local-data.json',
  'scripts/check-encoding.js',
]);
const SUSPICIOUS_MARKERS = [
  'Ã¡', 'Ã¢', 'Ã£', 'Ã§', 'Ã©', 'Ãª', 'Ã­', 'Ã³', 'Ãµ', 'Ãº', 'Ã‰', 'Ã“', 'Ã‡',
  'Ãƒ', 'Ãà', 'Ã', 'Â·', 'Âm', 'â€”', 'â€“', 'â€œ', 'â€\u009d', 'â€\u0099', 'â€¢', 'â€¦',
  'ðŸ', 'â†’', 'âˆ’', 'â•', 'â”€',
];

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const relative = path.relative(ROOT, full).replace(/\\/g, '/');
    if (IGNORE_FILES.has(relative)) continue;
    if (entry.name.startsWith('tmp_')) continue;
    files.push(full);
  }
}

function hasUtf8Replacement(content) {
  return content.includes('\uFFFD');
}

function findSuspiciousMarker(content) {
  return SUSPICIOUS_MARKERS.find((marker) => content.includes(marker)) || '';
}

function checkFile(file) {
  const buffer = fs.readFileSync(file);
  const content = buffer.toString('utf8');
  const problems = [];
  if (hasUtf8Replacement(content)) {
    problems.push('caractere de substituição U+FFFD encontrado');
  }
  const marker = findSuspiciousMarker(content);
  if (marker) {
    problems.push(`sequência suspeita de mojibake encontrada: "${marker}"`);
  }
  return problems;
}

function main() {
  const files = [];
  walk(ROOT, files);
  const issues = [];
  files.forEach((file) => {
    const problems = checkFile(file);
    if (!problems.length) return;
    issues.push({
      file: path.relative(ROOT, file),
      problems,
    });
  });

  if (!issues.length) {
    console.log('Encoding check: OK');
    return;
  }

  console.error('Encoding check: problemas encontrados');
  issues.forEach((issue) => {
    console.error(`- ${issue.file}`);
    issue.problems.forEach((problem) => console.error(`  - ${problem}`));
  });
  process.exitCode = 1;
}

main();
