const fs = require('fs');
const path = require('path');

function getArg(name, fallback = undefined) {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!raw) return fallback;
  return raw.slice(name.length + 3);
}

function getIntArg(name, fallback) {
  const value = getArg(name);
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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

async function main() {
  const input = getArg('input');
  const output = getArg('output', path.join('backups', 'workspace_rows.ndjson'));
  const delimiter = getArg('delimiter', ',');
  const mode = getArg('mode', 'raw'); // raw | csv
  const from = getIntArg('from', 2); // 1 = header
  const limit = getIntArg('limit', 0); // 0 = sem limite
  const progressEvery = getIntArg('progress', 100);

  if (!input) {
    console.error('Uso: node scripts/workspace-csv-stream.js --input=CAMINHO [--output=ARQUIVO] [--mode=raw|csv] [--from=2] [--limit=0] [--progress=100]');
    process.exit(1);
  }

  if (!fs.existsSync(input)) {
    console.error(`Arquivo nao encontrado: ${input}`);
    process.exit(1);
  }

  const outDir = path.dirname(output);
  if (outDir && outDir !== '.' && !fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const readStream = fs.createReadStream(input, { encoding: 'utf8' });
  const writeStream = fs.createWriteStream(output, { encoding: 'utf8' });

  let buffer = '';
  let inQuotes = false;
  let rowNumber = 0;
  let emitted = 0;
  let header = null;

  function handleRecord(recordRaw) {
    rowNumber += 1;

    const record = recordRaw.replace(/\r$/, '');
    const fields = parseCsvRecord(record, delimiter);

    if (rowNumber === 1) {
      header = fields;
      console.log(`Header detectado com ${header.length} colunas (bruto).`);
      return;
    }

    if (rowNumber < from) return;
    if (limit > 0 && emitted >= limit) return;

    let out;
    if (mode === 'csv') {
      const id = fields[0] || '';
      const data = fields[1] || '';
      const updatedAt = fields[2] || '';
      const updatedBy = fields[3] || '';
      const updatedByName = (fields[4] || '').replace(/;+$/g, '');

      out = {
        source_row: rowNumber,
        id,
        data,
        updated_at: updatedAt,
        updated_by: updatedBy,
        updated_by_name: updatedByName,
      };
    } else {
      const idMatch = record.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      out = {
        source_row: rowNumber,
        id_guess: idMatch ? idMatch[0] : '',
        raw: record,
      };
    }

    writeStream.write(`${JSON.stringify(out)}\n`);
    emitted += 1;

    if (progressEvery > 0 && emitted % progressEvery === 0) {
      console.log(`Processados ${emitted} registros... (linha origem atual: ${rowNumber})`);
    }
  }

  for await (const chunk of readStream) {
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
        if (line.length > 0) {
          handleRecord(line);
          if (limit > 0 && emitted >= limit) {
            readStream.destroy();
            break;
          }
        }

        if (ch === '\r' && buffer[i + 1] === '\n') {
          i += 1;
        }
        start = i + 1;
      }
    }

    buffer = buffer.slice(start);
    if (limit > 0 && emitted >= limit) break;
  }

  if (buffer.length > 0 && !(limit > 0 && emitted >= limit)) {
    handleRecord(buffer);
  }

  await new Promise((resolve) => {
    writeStream.end(resolve);
  });

  console.log(`Concluido. Registros emitidos: ${emitted}. Saida: ${output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
