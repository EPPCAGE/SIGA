import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import utils from './utils.js';

const { getArg, getBoolArg, parseCsvRecord, ensureDir, writeJsonAtomic } = utils;

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
  text = text.replaceAll('""', '"');
  // Cleanup accidental escaped newlines in one giant field.
  text = text.replaceAll('\r\n', '\n');

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
      // Mantem a varredura em outros candidatos da mesma linha.
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

  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const { reportPath, backupPath, snapshotPath } = buildArtifactPaths(migrationDir, timestamp);

  ensureDir(reportPath);

  const ndjsonSelection = await selectBestWorkspaceFromNdjson(input);
  let { lineNumber, parsedLines, validWorkspaceRows, best } = ndjsonSelection;

  let sourceKind = 'ndjson';

  if (!best) {
    best = selectBestWorkspaceFromBackups(output, backupFallback);
    if (best) sourceKind = 'backup-json';
  }

  if (!best) {
    throw new Error('Nenhum JSON de workspace valido foi extraido da origem NDJSON nem dos backups JSON.');
  }

  const current = loadCurrentRecord(output);

  if (fs.existsSync(output)) {
    writeJsonAtomic(backupPath, current);
  }

  const migrated = buildMigratedRecord(best, current, {
    sourceKind,
    input,
    validWorkspaceRows,
    lineNumber,
    parsedLines,
  });

  writeJsonAtomic(snapshotPath, migrated);
  if (apply) {
    writeJsonAtomic(output, migrated);
  }

  const report = await buildMigrationReport({
    apply,
    input,
    output,
    backupPath: fs.existsSync(output) ? backupPath : null,
    snapshotPath,
    sourceKind,
    best,
    lineNumber,
    parsedLines,
    validWorkspaceRows,
  });

  writeJsonAtomic(reportPath, report);

  console.info(`Migracao concluida com sucesso.`);
  console.info(`- Origem: ${input}`);
  console.info(`- Saida aplicada: ${apply ? output : 'nao aplicada (--apply=false)'}`);
  console.info(`- Snapshot: ${snapshotPath}`);
  if (report.backupPath) console.info(`- Backup pre-migracao: ${report.backupPath}`);
  console.info(`- Relatorio: ${reportPath}`);
  console.info(`- Linha selecionada: ${best.lineNumber} (source_row=${best.sourceRow || 'n/a'}, score=${best.score})`);
}

function buildArtifactPaths(migrationDir, timestamp) {
  return {
    reportPath: path.join(migrationDir, `migration-report-${timestamp}.json`),
    backupPath: path.join(migrationDir, `local-data.pre-migration-${timestamp}.json`),
    snapshotPath: path.join(migrationDir, `local-data.migrated-${timestamp}.json`),
  };
}

async function selectBestWorkspaceFromNdjson(input) {
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

    const candidate = scoreWorkspaceRow(row, lineNumber);
    if (!candidate) continue;

    validWorkspaceRows += 1;
    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  return { lineNumber, parsedLines, validWorkspaceRows, best };
}

function scoreWorkspaceRow(row, lineNumber) {
  const raw = typeof row.raw === 'string' ? row.raw : null;
  if (!raw) return null;

  const parsedWorkspace = tryParseWorkspaceJson(raw);
  if (!parsedWorkspace) return null;

  return {
    score: scoreWorkspaceData(parsedWorkspace),
    lineNumber,
    sourceRow: row.source_row || null,
    idGuess: row.id_guess || null,
    data: parsedWorkspace,
  };
}

function resolveBackupCandidates(output, backupFallback) {
  const backupsDir = path.join(path.dirname(output));
  if (backupFallback === 'auto') {
    return listBackupCandidates(backupsDir);
  }

  if (!backupFallback || backupFallback === 'none') {
    return [];
  }

  try {
    const validatedPath = validateFilePath(backupFallback, backupsDir);
    return [{ fullPath: validatedPath }];
  } catch (backupPathError) {
    console.warn(`Aviso: ${backupPathError.message}. Ignorando backupFallback.`);
    return [];
  }
}

function selectBestWorkspaceFromBackups(output, backupFallback) {
  const candidateList = resolveBackupCandidates(output, backupFallback);
  for (const candidate of candidateList) {
    try {
      const extracted = extractWorkspaceFromBackupJson(candidate.fullPath);
      if (!extracted) continue;
      return {
        score: extracted.score,
        lineNumber: null,
        sourceRow: null,
        idGuess: extracted.id,
        data: extracted.data,
        backupSelectedAt: extracted.updated_at,
        backupPath: candidate.fullPath,
      };
    } catch {
      // Um backup ruim nao deve bloquear a avaliacao dos demais.
    }
  }

  return null;
}

function loadCurrentRecord(output) {
  if (!fs.existsSync(output)) {
    return { id: 1, data: {}, updated_at: null, updated_by: 'migration', updated_by_name: 'migration' };
  }

  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

function buildMigratedRecord(best, current, stats) {
  return {
    id: 1,
    data: best.data,
    updated_at: new Date().toISOString(),
    updated_by: current.updated_by || 'migration@local',
    updated_by_name: current.updated_by_name || 'Migracao Segura',
    migration: {
      source_kind: stats.sourceKind,
      source_file: stats.input,
      source_backup_file: best.backupPath || null,
      selected_line: best.lineNumber,
      selected_source_row: best.sourceRow,
      selected_id_guess: best.idGuess,
      selected_backup_updated_at: best.backupSelectedAt || null,
      score: best.score,
      extracted_candidates: stats.validWorkspaceRows,
      processed_lines: stats.lineNumber,
      parsed_ndjson_lines: stats.parsedLines,
      executed_at: new Date().toISOString(),
    },
  };
}

async function buildMigrationReport(params) {
  return {
    ok: true,
    apply: params.apply,
    input: params.input,
    output: params.output,
    backupPath: params.backupPath,
    snapshotPath: params.snapshotPath,
    selected: {
      sourceKind: params.sourceKind,
      lineNumber: params.best.lineNumber,
      sourceRow: params.best.sourceRow,
      idGuess: params.best.idGuess,
      backupPath: params.best.backupPath || null,
      backupUpdatedAt: params.best.backupSelectedAt || null,
      score: params.best.score,
    },
    stats: {
      totalLines: params.lineNumber,
      parsedNdjsonLines: params.parsedLines,
      validWorkspaceRows: params.validWorkspaceRows,
      keysInData: Object.keys(params.best.data),
    },
    hashes: {
      inputSha256: await sha256File(params.input),
      snapshotSha256: await sha256File(params.snapshotPath),
      outputSha256: params.apply && fs.existsSync(params.output) ? await sha256File(params.output) : null,
    },
    generatedAt: new Date().toISOString(),
  };
}

try {
  await main();
} catch (err) {
  console.error(`Erro na migracao: ${err.message}`);
  process.exit(1);
}
