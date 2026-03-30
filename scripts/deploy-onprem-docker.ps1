param(
  [Parameter(Mandatory = $true)]
  [string]$PackageRoot,
  [Parameter(Mandatory = $true)]
  [string]$DeployRoot,
  [string]$AiProvider = 'azure',
  [string]$AzureEndpoint = '',
  [string]$AzureDeployment = '',
  [string]$AzureApiVersion = '',
  [string]$AzureApiKey = '',
  [string]$AuthMode = 'local',
  [string]$EntraClientId = '',
  [string]$EntraTenantId = '',
  [string]$AdminEmails = '',
  [string]$EditorEmails = '',
  [string]$AdminToken = '',
  [string]$AllowedOrigins = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-EnvFile {
  param(
    [string]$Path,
    [hashtable]$Values
  )

  $lines = foreach ($entry in $Values.GetEnumerator()) {
    '{0}={1}' -f $entry.Key, $entry.Value
  }
  Set-Content -LiteralPath $Path -Value ($lines -join [Environment]::NewLine) -Encoding UTF8
}

$packageFullPath = [System.IO.Path]::GetFullPath($PackageRoot)
$deployFullPath = [System.IO.Path]::GetFullPath($DeployRoot)

if (-not (Test-Path $packageFullPath)) {
  throw "Pacote de deploy nao encontrado: $packageFullPath"
}

$requiredItems = @(
  'docker-compose.yml',
  'docker',
  'modules',
  'scripts',
  'index.html',
  'sw.js',
  'package.json',
  'package-lock.json'
)

foreach ($item in $requiredItems) {
  if (-not (Test-Path (Join-Path $packageFullPath $item))) {
    throw "Item obrigatorio ausente no pacote: $item"
  }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker nao esta disponivel no servidor de deploy.'
}

docker compose version | Out-Null

if (-not (Test-Path $deployFullPath)) {
  New-Item -ItemType Directory -Path $deployFullPath | Out-Null
}

$managedItems = @(
  'docker-compose.yml',
  'docker',
  'modules',
  'scripts',
  'index.html',
  'sw.js',
  'package.json',
  'package-lock.json',
  'public-config.entra.example.js',
  'public-config.js',
  '.env',
  'deploy-manifest.json'
)

foreach ($item in $managedItems) {
  $targetPath = Join-Path $deployFullPath $item
  if (Test-Path $targetPath) {
    Remove-Item -LiteralPath $targetPath -Recurse -Force
  }
}

Get-ChildItem -LiteralPath $packageFullPath -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $deployFullPath $_.Name) -Recurse -Force
}

& (Join-Path $deployFullPath 'scripts\write-public-config.ps1') `
  -OutputPath (Join-Path $deployFullPath 'public-config.js') `
  -AuthMode $AuthMode `
  -EntraClientId $EntraClientId `
  -EntraTenantId $EntraTenantId `
  -AdminEmails $AdminEmails `
  -EditorEmails $EditorEmails

$envValues = @{
  SIGA_AI_PROVIDER       = $AiProvider
  SIGA_AZURE_ENDPOINT    = $AzureEndpoint
  SIGA_AZURE_DEPLOYMENT  = $AzureDeployment
  SIGA_AZURE_API_VERSION = $AzureApiVersion
  SIGA_AZURE_API_KEY     = $AzureApiKey
  SIGA_ADMIN_TOKEN       = $AdminToken
  SIGA_ALLOWED_ORIGIN    = $AllowedOrigins
}

Write-EnvFile -Path (Join-Path $deployFullPath '.env') -Values $envValues

Push-Location $deployFullPath
try {
  docker compose up -d --build
} finally {
  Pop-Location
}

Write-Host "Deploy on-prem concluido em: $deployFullPath"
