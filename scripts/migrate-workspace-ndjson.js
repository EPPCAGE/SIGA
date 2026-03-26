const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { getArg, getBoolArg, parseCsvRecord, ensureDir, writeJsonAtomic } = require('./utils');

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Valida que filePath está dentro do basePath (previne path traversal)
 */
function validateFilePath(filePath, basePath) {
  const resolved = path.resolve(filePath);
  const baseResolved = path.resolve(basePath);
  if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
    throw new Error(`Path traversal detectado: ${filePath}`);
  }
  return resolved;
}

function normalizeCandidate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) return null;

  text = text.slice(firstBrace, lastBrace + 1);

  // Repeated CSV escaping found in raw exports.
  text = text.replace(/""/g, '"');
  // Cleanup accidental escaped newlines in one giant field.
  text = text.replace(/\r\n/g, '\n');

  return text;
}

function tryParseWorkspaceJson(raw) {
  const candidates = [];

  const csvFields = parseCsvRecord(raw, ',');
  for (const field of csvFields) {
    if (field.includes('{') && field.includes('}')) candidates.push(field);
  }

  candidates.push(raw);

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    if (!normalized) continue;
    try {
      const parsed = JSON.parse(normalized);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Keep trying with next candidate.
    }
  }

  return null;
}

function scoreWorkspaceData(data) {
  if (!data || typeof data !== 'object') return -1;
  let score = 0;
  if (data.d && typeof data.d === 'object') score += 30;
  if (data.r && typeof data.r === 'object') score += 30;
  if (Array.isArray(data.pat)) score += 10;
  if (data.config && typeof data.config === 'object') score += 10;
  if (Array.isArray(data.newPops)) score += 10;
  if (Array.isArray(data.drops)) score += 5;
  if (Array.isArray(data.repoDocs)) score += 5;
  const payloadSize = JSON.stringify(data).length;
  score += Math.min(50, Math.floor(payloadSize / 100000));
  return score;
}

function listBackupCandidates(backupsDir) {
  if (!fs.existsSync(backupsDir)) return [];
  return fs
    .readdirSync(backupsDir)
    .filter((name) => /^backup-.*\.json$/i.test(name))
    .map((name) => ({
      name,
      fullPath: path.join(backupsDir, name),
      mtimeMs: fs.statSync(path.join(backupsDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function extractWorkspaceFromBackupJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  const rows = parsed?.tables?.gestpop_workspace;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const ranked = rows
    .map((row, index) => {
      const data = row?.data && typeof row.data === 'object' ? row.data : null;
      if (!data) return null;
      const score = scoreWorkspaceData(data);
      const updatedAtMs = row?.updated_at ? Date.parse(row.updated_at) || 0 : 0;
      return {
        index,
        id: row?.id || null,
        updated_at: row?.updated_at || null,
        score,
        data,
        updatedAtMs,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.updatedAtMs - a.updatedAtMs;
    });

  return ranked[0] || null;
}

async function main() {
  const input = getArg('input', path.join('backups', 'workspace_rows.full.ndjson'));
  const output = getArg('output', path.join('backups', 'local-data.json'));
  const apply = getBoolArg('apply', true);
  const migrationDir = getArg('migrationDir', path.join('backups', 'migration'));
  const backupFallback = getArg('backupFallback', 'auto');

  if (!fs.existsSync(input)) {
    throw new Error(`Arquivo de entrada nao encontrado: ${input}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(migrationDir, `migration-report-${timestamp}.json`);
  const backupPath = path.join(migrationDir, `local-data.pre-migration-${timestamp}.json`);
  const snapshotPath = path.join(migrationDir, `local-data.migrated-${timestamp}.json`);

  ensureDir(reportPath);

  let lineNumber = 0;
  let parsedLines = 0;
  let validWorkspaceRows = 0;
  let best = null;

  const inputRl = readline.createInterface({
    input: fs.createReadStream(input, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of inputRl) {
    lineNumber += 1;
    if (!line.trim()) continue;

    let row;
    try {
      row = JSON.parse(line);
      parsedLines += 1;
    } catch {
      continue;
    }

    const raw = typeof row.raw === 'string' ? row.raw : null;
    if (!raw) continue;

    const parsedWorkspace = tryParseWorkspaceJson(raw);
    if (!parsedWorkspace) continue;

    validWorkspaceRows += 1;
    const score = scoreWorkspaceData(parsedWorkspace);
    if (!best || score > best.score) {
      best = {
        score,
        lineNumber,
        sourceRow: row.source_row || null,
        idGuess: row.id_guess || null,
        data: parsedWorkspace,
      };
    }
  }

  let sourceKind = 'ndjson';

  if (!best) {
    const backupsDir = path.join(path.dirname(output));
    let candidateList = [];

    if (backupFallback === 'auto') {
      candidateList = listBackupCandidates(backupsDir);
    } else if (backupFallback && backupFallback !== 'none') {
      try {
        const validatedPath = validateFilePath(backupFallback, backupsDir);
        candidateList = [{ fullPath: validatedPath }];
      } catch (err) {
        console.warn(`Aviso: ${err.message}. Ignorando backupFallback.`);
        candidateList = [];
      }
    }

    for (const candidate of candidateList) {
      try {
        const extracted = extractWorkspaceFromBackupJson(candidate.fullPath);
        if (!extracted) continue;
        best = {
          score: extracted.score,
          lineNumber: null,
          sourceRow: null,
          idGuess: extracted.id,
          data: extracted.data,
          backupSelectedAt: extracted.updated_at,
          backupPath: candidate.fullPath,
        };
        sourceKind = 'backup-json';
        break;
      } catch {
        // Try next backup file.
      }
    }
  }

  if (!best) {
    throw new Error('Nenhum JSON de workspace valido foi extraido da origem NDJSON nem dos backups JSON.');
  }

  const current = fs.existsSync(output)
    ? JSON.parse(fs.readFileSync(output, 'utf8'))
    : { id: 1, data: {}, updated_at: null, updated_by: 'migration', updated_by_name: 'migration' };

  if (fs.existsSync(output)) {
    writeJsonAtomic(backupPath, current);
  }

  const migrated = {
    id: 1,
    data: best.data,
    updated_at: new Date().toISOString(),
    updated_by: current.updated_by || 'migration@local',
    updated_by_name: current.updated_by_name || 'Migracao Segura',
    migration: {
      source_kind: sourceKind,
      source_file: input,
      source_backup_file: best.backupPath || null,
      selected_line: best.lineNumber,
      selected_source_row: best.sourceRow,
      selected_id_guess: best.idGuess,
      selected_backup_updated_at: best.backupSelectedAt || null,
      score: best.score,
      extracted_candidates: validWorkspaceRows,
      processed_lines: lineNumber,
      parsed_ndjson_lines: parsedLines,
      executed_at: new Date().toISOString(),
    },
  };

  writeJsonAtomic(snapshotPath, migrated);
  if (apply) {
    writeJsonAtomic(output, migrated);
  }

  const report = {
    ok: true,
    apply,
    input,
    output,
    backupPath: fs.existsSync(output) ? backupPath : null,
    snapshotPath,
    selected: {
      sourceKind,
      lineNumber: best.lineNumber,
      sourceRow: best.sourceRow,
      idGuess: best.idGuess,
      backupPath: best.backupPath || null,
      backupUpdatedAt: best.backupSelectedAt || null,
      score: best.score,
    },
    stats: {
      totalLines: lineNumber,
      parsedNdjsonLines: parsedLines,
      validWorkspaceRows,
      keysInData: Object.keys(best.data),
    },
    hashes: {
      inputSha256: await sha256File(input),
      snapshotSha256: await sha256File(snapshotPath),
      outputSha256: apply && fs.existsSync(output) ? await sha256File(output) : null,
    },
    generatedAt: new Date().toISOString(),
  };

  atomicWriteJson(reportPath, report);

  console.log(`Migracao concluida com sucesso.`);
  console.log(`- Origem: ${input}`);
  console.log(`- Saida aplicada: ${apply ? output : 'nao aplicada (--apply=false)'}`);
  console.log(`- Snapshot: ${snapshotPath}`);
  if (report.backupPath) console.log(`- Backup pre-migracao: ${report.backupPath}`);
  console.log(`- Relatorio: ${reportPath}`);
  console.log(`- Linha selecionada: ${best.lineNumber} (source_row=${best.sourceRow || 'n/a'}, score=${best.score})`);
}

main().catch((err) => {
  console.error(`Erro na migracao: ${err.message}`);
  process.exit(1);
});
