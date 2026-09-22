param(
  [int]$Port = 3026,
  [string]$InfraRoot = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Import-DotEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }

  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
    $name = $matches[1]
    $value = $matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

if ($Port -lt 1 -or $Port -gt 65535) {
  throw "Port must be between 1 and 65535"
}

if (-not $InfraRoot) {
  $siblingRoot = Join-Path (Split-Path -Parent $repoRoot) "joyce-work-schedule"
  $InfraRoot = if (Test-Path -LiteralPath (Join-Path $repoRoot ".env.db.local")) {
    $repoRoot
  } else {
    $siblingRoot
  }
}

$infraFile = Join-Path $InfraRoot ".env.db.local"
if (-not (Test-Path -LiteralPath $infraFile)) {
  throw "Missing local infrastructure configuration: $infraFile"
}

# Load existing local credentials into this process only. Nothing is printed
# and no credential file is copied into the shadow-pilot checkout.
Import-DotEnv (Join-Path $InfraRoot ".env")
Import-DotEnv $infraFile

$required = @("MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE")
foreach ($name in $required) {
  if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
    throw "$name is required in $infraFile"
  }
}

$mysqlPort = [Environment]::GetEnvironmentVariable("MYSQL_PORT", "Process")
if (-not $mysqlPort) { $mysqlPort = "3307" }
$redisPort = [Environment]::GetEnvironmentVariable("REDIS_PORT", "Process")
if (-not $redisPort) { $redisPort = "6379" }
$dbUser = [Uri]::EscapeDataString([Environment]::GetEnvironmentVariable("MYSQL_USER", "Process"))
$dbPassword = [Uri]::EscapeDataString([Environment]::GetEnvironmentVariable("MYSQL_PASSWORD", "Process"))
$dbName = [Uri]::EscapeDataString([Environment]::GetEnvironmentVariable("MYSQL_DATABASE", "Process"))

$env:NODE_ENV = "development"
$env:HOST = "127.0.0.1"
$env:PORT = [string]$Port
$env:LOCAL_AUTH_BYPASS = "true"
$env:LOCAL_AUTH_BYPASS_OPEN_ID = ""
$env:DATABASE_URL = "mysql://${dbUser}:${dbPassword}@127.0.0.1:${mysqlPort}/${dbName}"
if ($env:REDIS_PASSWORD) {
  $env:REDIS_URL = "redis://:$([Uri]::EscapeDataString($env:REDIS_PASSWORD))@127.0.0.1:${redisPort}"
}
if (-not $env:JWT_SECRET) { $env:JWT_SECRET = "local-dashboard-development-secret-only" }
if (-not $env:VITE_APP_ID) { $env:VITE_APP_ID = "va-dashboard" }
$env:PUBLIC_URL = ""
$env:APP_URL = ""
$env:WEBHOOK_BASE_URL = ""
$env:TRELLO_WEBHOOK_CALLBACK_URL = ""
$env:LOCAL_ACCESS_ORIGINS = "http://127.0.0.1:${Port},http://localhost:${Port}"
$env:BRIEFING_SCHEDULER_ENABLED = "false"
$env:REMINDER_WORKER_ENABLED = "false"
$env:NOTIFICATIONS_ENABLED = "false"
$env:APTLSS_MANAGER_SCHEDULER = "false"

Set-Location $repoRoot
$tsx = Join-Path $repoRoot "node_modules\tsx\dist\cli.mjs"
if (-not (Test-Path -LiteralPath $tsx)) {
  throw "Missing local tsx runtime: $tsx"
}

Write-Output "Starting local dashboard on http://127.0.0.1:${Port}/worker"
Write-Output "Authentication bypass is loopback-only; public ngrok remains unchanged."
& node $tsx "server/_core/index.ts"
exit $LASTEXITCODE
