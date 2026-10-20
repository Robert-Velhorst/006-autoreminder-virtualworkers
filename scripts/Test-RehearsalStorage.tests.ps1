$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '../.local/pilot/codex-private'
$parent = (Resolve-Path -LiteralPath $root).ProviderPath
$target = Join-Path $parent ('storage-test-' + [guid]::NewGuid().ToString('N'))
$alias = Join-Path $parent ('storage-test-' + [guid]::NewGuid().ToString('N'))
$check = Join-Path $PSScriptRoot 'Test-RehearsalStorage.ps1'
$passed = 0
function Expect-Rejection([scriptblock]$Action, [string]$Message) {
  try { & $Action | Out-Null } catch {
    if ($_.Exception.Message -notlike ('*' + $Message + '*')) { throw }
    return
  }
  throw 'Unsafe storage unexpectedly accepted'
}
try {
  New-Item -ItemType Directory -Path $target | Out-Null
  Expect-Rejection { & $check -Directory $target -BackupBytes 1 } 'Inherited access must be disabled'
  $passed++
  $acl = Get-Acl -LiteralPath $parent
  $acl.SetAccessRuleProtection($true,$false)
  Set-Acl -LiteralPath $target -AclObject $acl
  $result = & $check -Directory $target -BackupBytes 1 | ConvertFrom-Json
  if (-not $result.StorageVerified -or $result.ApplicationRollbackVerified) { throw 'Positive control failed' }
  $passed++
  Expect-Rejection { & $check -Directory $target -BackupBytes 1 -ReserveBytes 0 } 'Invalid restore capacity'
  $passed++
  Expect-Rejection { & $check -Directory $target -BackupBytes ([long]::MaxValue) } 'Insufficient protected storage'
  $passed++
  New-Item -ItemType Directory -Path (Join-Path $target 'nested') | Out-Null
  New-Item -ItemType Junction -Path $alias -Target $target | Out-Null
  Expect-Rejection { & $check -Directory (Join-Path $alias 'nested') -BackupBytes 1 } 'Reparse-point ancestors'
  $passed++
  Remove-Item -LiteralPath (Join-Path $target 'nested')
  [pscustomobject]@{Passed=$passed; Failed=0; ProductionTouched=$false} | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $alias) {
    $link = Get-Item -LiteralPath $alias -Force
    if ((Split-Path $link.FullName) -ne $parent -or -not ($link.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe link cleanup target' }
    Remove-Item -LiteralPath $alias
  }
  if (Test-Path -LiteralPath $target) {
    $resolved = (Resolve-Path -LiteralPath $target).ProviderPath
    if ($resolved -ne $target -or (Split-Path $resolved) -ne $parent) { throw 'Unsafe cleanup target' }
    if (@(Get-ChildItem -LiteralPath $target -Force).Count -ne 0) { throw 'Unexpected test contents; cleanup refused' }
    Remove-Item -LiteralPath $target
  }
}
