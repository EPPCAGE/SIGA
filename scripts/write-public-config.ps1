param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [string]$AuthMode = 'local',
  [string]$EntraClientId = '',
  [string]$EntraTenantId = '',
  [string]$AdminEmails = '',
  [string]$EditorEmails = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertToJsArrayLiteral {
  param([string]$Value)

  $items = @()
  if ($Value) {
    $items = $Value.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  }

  if (-not $items.Count) {
    return '[]'
  }

  $quoted = $items | ForEach-Object { "'$($_.Replace("'", "\'"))'" }
  return '[' + ($quoted -join ', ') + ']'
}

$authModeValue = if ($AuthMode) { $AuthMode } else { 'local' }
$adminEmailsLiteral = ConvertToJsArrayLiteral -Value $AdminEmails
$editorEmailsLiteral = ConvertToJsArrayLiteral -Value $EditorEmails

$content = @"
globalThis.__SIGA_RUNTIME__ = {
  apiUrl: '/api',
  auth: {
    mode: '$authModeValue',
    entra: {
      clientId: '$EntraClientId',
      tenantId: '$EntraTenantId',
      redirectUri: globalThis.location.origin,
      adminEmails: $adminEmailsLiteral,
      editorEmails: $editorEmailsLiteral,
    },
  },
};
"@

Set-Content -LiteralPath $OutputPath -Value $content -Encoding UTF8
