param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$target = [System.IO.Path]::GetFullPath($OutputPath)

if (Test-Path $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}

New-Item -ItemType Directory -Path $target | Out-Null

$itemsToCopy = @(
  'docker-compose.yml',
  'index.html',
  'sw.js',
  'package.json',
  'package-lock.json',
  'public-config.entra.example.js',
  'docker',
  'modules',
  'scripts'
)

foreach ($relative in $itemsToCopy) {
  $source = Join-Path $repoRoot $relative
  if (-not (Test-Path $source)) {
    throw "Item obrigatorio ausente no pacote de deploy: $relative"
  }
  Copy-Item -LiteralPath $source -Destination (Join-Path $target $relative) -Recurse -Force
}

# O build roda em Windows; normalize scripts shell no artefato para LF antes de publicar.
Get-ChildItem -Path $target -Recurse -Filter *.sh | ForEach-Object {
  $content = Get-Content -LiteralPath $_.FullName -Raw
  $content = $content -replace "`r`n", "`n"
  [System.IO.File]::WriteAllText($_.FullName, $content, [System.Text.UTF8Encoding]::new($false))
}

$manifest = [ordered]@{
  buildId    = $env:BUILD_BUILDID
  branch     = $env:BUILD_SOURCEBRANCH
  commit     = $env:BUILD_SOURCEVERSION
  generatedAt = (Get-Date).ToString('s')
  packageType = 'docker-compose-onprem'
}

$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'deploy-manifest.json') -Encoding UTF8

Write-Host "Pacote on-prem gerado em: $target"
