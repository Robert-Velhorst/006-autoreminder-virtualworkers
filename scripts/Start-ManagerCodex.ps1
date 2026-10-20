$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$codex = (Get-Command codex.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$queue = Join-Path $root '.local/pilot/codex-queue'
$private = Join-Path $root '.local/pilot/codex-private'
New-Item -ItemType Directory -Path $queue,$private -Force | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($directory in @($queue,$private)) {
  & icacls $directory /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot protect the local Codex transport directory.' }
}
$env:APTLSS_CODEX_EXECUTABLE = $codex
$lock = Join-Path $private 'runner.lock'
if (Test-Path -LiteralPath $lock) {
  $runnerId = 0
  if ([int]::TryParse((Get-Content -LiteralPath $lock -Raw).Trim(), [ref]$runnerId)) {
    if (Get-Process -Id $runnerId -ErrorAction SilentlyContinue) { throw 'The Codex runner is already active. Do not start a second runner.' }
  }
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$started = [DateTimeOffset]::UtcNow
$process = Start-Process -FilePath $node -ArgumentList @('node_modules/tsx/dist/cli.mjs','scripts/run-manager-codex.ts') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $private "runner-$stamp.log") -RedirectStandardError (Join-Path $private "runner-$stamp.err")
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  $process.Refresh()
  if ($process.HasExited) { throw 'Codex runner did not start. Check its local diagnostic log.' }
  try {
    $heartbeat = Get-Content -LiteralPath (Join-Path $queue 'heartbeat.json') -Raw | ConvertFrom-Json
    if ([DateTimeOffset]$heartbeat.at -ge $started -and $heartbeat.model -eq 'gpt-5.6-luna' -and $heartbeat.route -eq 'luna-adaptive-v1' -and ($heartbeat.efforts -join ',') -eq 'low,medium,high') { $ready = $true; break }
  } catch { }
}
if (-not $ready) { throw 'Codex runner did not confirm readiness within ten seconds.' }
[pscustomobject]@{ProcessId=$process.Id;Model='gpt-5.6-luna';Reasoning='low -> medium -> high (as needed)';Transport='Private local directory; no listening port'} | ConvertTo-Json
