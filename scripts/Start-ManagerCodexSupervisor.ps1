$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$env:APTLSS_CODEX_EXECUTABLE = (Get-Command codex.exe -ErrorAction Stop).Source
Push-Location -LiteralPath $root
try {
  & $node (Join-Path $PSScriptRoot 'manager-codex-supervisor.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Codex supervisor stopped with an error. Inspect its lease and existing runner before retrying.' }
} finally {
  Pop-Location
}
