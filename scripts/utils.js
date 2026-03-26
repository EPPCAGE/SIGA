const fs = require('fs');
const path = require('path');

/**
 * Extrai valor de argumento CLI no formato --name=value
 */
function getArg(name, fallback = undefined) {
  const token = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!token) return fallback;
  return token.slice(name.length + 3);
}

/**
 * Extrai valor booleano de argumento CLI
 */
function getBoolArg(name, fallback) {
  const value = getArg(name);
  if (value == null) return fallback;
  return String(value).toLowerCase() === 'true';
}

/**
 * Extrai valor inteiro de argumento CLI
 */
function getIntArg(name, fallback) {
  const value = getArg(name);
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Faz parsing de registro CSV respeitando aspas e delimitadores
 */
function parseCsvRecord(record, delimiter = ',') {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < record.length; i += 1) {
    const ch = record[i];
    if (ch === '"') {
      if (inQuotes && record[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }

  fields.push(current);
  return fields;
}

/**
 * Cria diretório pai se não existir
 */
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Escreve JSON de forma atômica (usa arquivo temp + rename)
 */
function writeJsonAtomic(filePath, payload) {
  ensureDir(filePath);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

module.exports = {
  getArg,
  getBoolArg,
  getIntArg,
  parseCsvRecord,
  ensureDir,
  writeJsonAtomic,
};
