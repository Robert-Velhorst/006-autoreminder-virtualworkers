$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'browser-extension'
$output = Join-Path $root 'client/public/downloads'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$files = @('manifest.json', 'collector-core.js', 'service-worker.js', 'options.html', 'options.js', 'popup.html', 'popup.js') | ForEach-Object { Join-Path $source $_ }
Compress-Archive -LiteralPath $files -DestinationPath (Join-Path $output 'worker-browser-collector.zip') -Force
Write-Output 'Packaged worker collector without credentials'
