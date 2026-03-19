#!/usr/bin/env node
// Daily backup script — fetches all Supabase tables and saves to backups/
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const TABLES = [
  'gestpop_workspace',
  'gestpop_editors',
  'gestpop_requests',
  'gestpop_history',
  'gestpop_access_logs',
];

async function main() {
  const backup = {
    _version: 3,
    _exported: new Date().toISOString(),
    _app: 'SIGA',
    tables: {},
  };

  for (const table of TABLES) {
    const { data, error } = await supabase.from(table).select('*');
    if (error) {
      console.error(`✗ ${table}: ${error.message}`);
      backup.tables[table] = { error: error.message };
    } else {
      console.log(`✓ ${table}: ${data.length} rows`);
      backup.tables[table] = data;
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(process.cwd(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const filename = path.join(dir, `backup-${date}.json`);
  fs.writeFileSync(filename, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`\n✅ Backup salvo: ${filename}`);

  // Remove backups older than 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const fPath = path.join(dir, f);
    if (fs.statSync(fPath).mtimeMs < cutoff) {
      fs.unlinkSync(fPath);
      console.log(`🗑  Removido backup antigo: ${f}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
