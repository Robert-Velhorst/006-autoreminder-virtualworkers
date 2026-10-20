param(
  [Parameter(Mandatory=$true)][string]$Directory,
  [Parameter(Mandatory=$true)][long]$BackupBytes,
  [long]$ReserveBytes = 12884901888
)
$ErrorActionPreference = 'Stop'
if ($BackupBytes -le 0 -or $ReserveBytes -lt 12884901888) { throw 'Invalid restore capacity requirement' }
$resolved = (Resolve-Path -LiteralPath $Directory).ProviderPath
if ($resolved -notmatch '^([A-Za-z]):\\') { throw 'Only a local drive-backed test directory is supported' }
$letter = $Matches[1]
$item = Get-Item -LiteralPath $resolved -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'A real test directory is required' }
$ancestor = $item.Parent
while ($null -ne $ancestor) {
  if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Reparse-point ancestors prevent reliable storage verification'
  }
  $ancestor = $ancestor.Parent
}
$volume = Get-Volume -DriveLetter $letter
if ($volume.FileSystem -ne 'NTFS') { throw 'Private rehearsal storage requires NTFS access control' }
$acl = Get-Acl -LiteralPath $resolved
if (-not $acl.AreAccessRulesProtected) { throw 'Inherited access must be disabled for private rehearsal storage' }
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($owner, 'S-1-5-18')
$seen = @()
foreach ($rule in $acl.Access) {
  $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if ($sid -notin $allowed -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or
      ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) {
    throw 'Private rehearsal directory permissions are not restricted to owner and SYSTEM'
  }
  $seen += $sid
}
if (@($seen | Select-Object -Unique).Count -ne 2) { throw 'Required private directory permissions are missing' }
$required = [decimal]$BackupBytes + [decimal]$ReserveBytes
if ([decimal]$volume.SizeRemaining -lt $required) { throw 'Insufficient protected storage for restore and reserve' }
[pscustomobject]@{
  StorageVerified = $true
  FileSystem = 'NTFS'
  FreeBytes = [string]$volume.SizeRemaining
  RequiredBytes = [string]$required
  ApplicationRollbackVerified = $false
} | ConvertTo-Json -Compress
