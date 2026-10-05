<#
.SYNOPSIS
  Start Codex inside a herdr pane with the herdr-bridge role instructions and MCP server.

.DESCRIPTION
  Everything is passed as `codex -c` overrides for this one process (built by
  bridge/cli.mjs codex-launch): nothing is written to ~/.codex, AGENTS.md,
  skills or the repo. A plain `codex` elsewhere is unaffected.

.EXAMPLE
  .\herdr-codex.ps1 -Role commander -WithDashboard
  .\herdr-codex.ps1 -Role worker
#>
param(
  [ValidateSet('commander', 'worker')]
  [string]$Role = 'commander',
  [switch]$WithDashboard,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CodexArgs
)

$ErrorActionPreference = 'Stop'

if ($env:HERDR_ENV -ne '1' -or -not $env:HERDR_PANE_ID) {
  Write-Error 'herdr-codex: not inside a herdr pane (HERDR_ENV/HERDR_PANE_ID missing); start plain codex instead.'
  exit 2
}

$cli = Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'bridge') 'cli.mjs'
$node = (Get-Command node -ErrorAction Stop).Source
$extra = @()
if ($CodexArgs) { $extra = @($CodexArgs) }

# The payload travels base64-encoded so PowerShell never quotes JSON.
$payload = @{
  role      = $Role
  pane      = $env:HERDR_PANE_ID
  workspace = $env:HERDR_WORKSPACE_ID
  dashboard = [bool]$WithDashboard
  extra     = $extra
} | ConvertTo-Json -Compress
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))

& $node $cli 'codex-launch' "b64:$b64"
exit $LASTEXITCODE
