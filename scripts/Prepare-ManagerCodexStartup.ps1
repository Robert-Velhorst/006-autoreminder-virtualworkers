$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$launcher = Join-Path $PSScriptRoot 'Start-ManagerCodexSupervisor.ps1'
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $launcher + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'VA Dashboard private Codex host supervisor. No elevated permissions or stored account password.'
$directory = Join-Path (Split-Path -Parent $PSScriptRoot) '.local/pilot/codex-private'
if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'The protected private directory must already exist.' }
$destination = Join-Path $directory 'codex-startup-task.xml'
# Preparation only: registration and replacement of the running host process require approval.
$task | Export-ScheduledTask | Set-Content -LiteralPath $destination -Encoding Unicode
[pscustomobject]@{Prepared=$destination;Installed=$false;Trigger='Current user logon';Elevated=$false} | ConvertTo-Json
