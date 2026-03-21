const fs = require('fs');
const path = require('path');

function getArg(name, fallback = undefined) {
  const token = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!token) return fallback;
  return token.slice(name.length + 3);
}

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

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(filePath, payload) {
  ensureDir(filePath);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function normalizeValue(header, raw) {
  if (raw == null) return null;
  const value = String(raw).replace(/\r$/, '');

  if (value === '') return null;

  if (header === 'is_admin') {
    return value.toLowerCase() === 'true';
  }

  if (header === 'id' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  return value;
}

async function parseCsvFile(filePath, delimiter = ',') {
  if (!fs.existsSync(filePath)) {
    return { missing: true, rows: [], headers: [] };
  }

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });

  let buffer = '';
  let inQuotes = false;
  let headers = null;
  const rows = [];

  function pushRecord(recordRaw) {
    const record = recordRaw.replace(/\r$/, '');
    if (!record) return;

    const fields = parseCsvRecord(record, delimiter);

    if (!headers) {
      headers = fields.map((item) => String(item || '').trim());
      return;
    }

    const row = {};

    for (let i = 0; i < headers.length; i += 1) {
      const key = headers[i] || `column_${i + 1}`;
      row[key] = normalizeValue(key, fields[i]);
    }

    rows.push(row);
  }

  for await (const chunk of stream) {
    buffer += chunk;

    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const ch = buffer[i];

      if (ch === '"') {
        if (inQuotes && buffer[i + 1] === '"') {
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if ((ch === '\n' || ch === '\r') && !inQuotes) {
        const line = buffer.slice(start, i);
        pushRecord(line);

        if (ch === '\r' && buffer[i + 1] === '\n') {
          i += 1;
        }

        start = i + 1;
      }
    }

    buffer = buffer.slice(start);
  }

  if (buffer.length > 0) {
    pushRecord(buffer);
  }

  return { missing: false, headers: headers || [], rows };
}

async function main() {
  const baseDir = getArg('baseDir', path.join('backups'));
  const output = getArg('output', path.join(baseDir, 'migration', `backup-csv-tables-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const report = getArg('report', path.join(baseDir, 'migration', `csv-tables-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));

  const specs = [
    { table: 'gestpop_access_logs', file: 'gestpop_access_logs_rows.csv' },
    { table: 'gestpop_history', file: 'gestpop_history_rows.csv' },
    { table: 'gestpop_requests', file: 'gestpop_requests_rows.csv' },
    { table: 'gestpop_editors', file: 'gestpop_editors_rows.csv' },
    { table: 'gestpop_presence', file: 'gestpop_presence_rows.csv' },
    { table: 'gestpop_data', file: 'gestpop_data_rows.csv' },
  ];

  const tables = {};
  const summary = [];
  const missingFiles = [];

  for (const spec of specs) {
    const csvPath = path.join(baseDir, spec.file);
    const parsed = await parseCsvFile(csvPath);

    if (parsed.missing) {
      missingFiles.push(csvPath);
      tables[spec.table] = [];
      summary.push({ table: spec.table, source: csvPath, found: false, rows: 0, headers: [] });
      continue;
    }

    tables[spec.table] = parsed.rows;
    summary.push({
      table: spec.table,
      source: csvPath,
      found: true,
      rows: parsed.rows.length,
      headers: parsed.headers,
    });
  }

  const payload = {
    _version: 1,
    _exported: new Date().toISOString(),
    _source: 'csv',
    _app: 'SIGA',
    tables,
  };

  const reportPayload = {
    ok: missingFiles.length === 0,
    generatedAt: new Date().toISOString(),
    baseDir,
    output,
    summary,
    missingFiles,
    note: 'gestpop_workspace e migrado por scripts especificos: workspace-csv-stream + migrate-workspace-ndjson',
  };

  writeJsonAtomic(output, payload);
  writeJsonAtomic(report, reportPayload);

  console.log(`Backup CSV gerado: ${output}`);
  console.log(`Relatorio gerado: ${report}`);
  for (const item of summary) {
    const status = item.found ? 'OK' : 'MISSING';
    console.log(`- ${item.table}: ${status} (${item.rows} linhas)`);
  }

  if (missingFiles.length > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
