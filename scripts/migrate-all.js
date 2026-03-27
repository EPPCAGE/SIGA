const { spawnSync } = require('node:child_process');
const path = require('node:path');

function runStep(label, command, args) {
  console.log(`\n[${label}] Iniciando: ${command} ${args.join(' ')}`);

  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(`[${label}] Falhou com codigo ${result.status}`);
  }

  console.log(`[${label}] Concluido com sucesso.`);
}

function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const workspaceCsv = path.join('backups', 'gestpop_workspace_rows.csv');
  const workspaceNdjson = path.join('backups', 'workspace_rows.full.ndjson');

  runStep('workspace-csv-stream', 'node', [
    path.join('scripts', 'workspace-csv-stream.js'),
    `--input=${workspaceCsv}`,
    `--output=${workspaceNdjson}`,
    '--mode=raw',
    '--from=2',
    '--progress=500',
  ]);

  runStep('migrate-workspace', 'node', [
    path.join('scripts', 'migrate-workspace-ndjson.mjs'),
    `--input=${workspaceNdjson}`,
    `--apply=${isDryRun ? 'false' : 'true'}`,
  ]);

  runStep('migrate-csv-tables', 'node', [
    path.join('scripts', 'migrate-csv-tables.js'),
  ]);

  if (isDryRun) {
    console.log('\nFluxo completo finalizado em modo dry-run (sem aplicar local-data).');
  } else {
    console.log('\nFluxo completo finalizado com sucesso.');
  }
}

main();
