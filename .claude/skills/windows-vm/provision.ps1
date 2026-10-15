$ErrorActionPreference = 'Stop'
Set-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1
# QEMU hands Windows a UTC hardware clock, which Windows reads as local time unless told otherwise. Output dated in the future never rebuilds, so it goes.
Set-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\TimeZoneInformation -Name RealTimeIsUniversal -Type DWord -Value 1
$now = Get-Date
Get-ChildItem C:\work\modbench\MEditService -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt $now -and $_.FullName -match '\\(bin|obj)\\' } |
  Remove-Item -Force
# The machine's policy, written where Set-ExecutionPolicy writes it: the cmdlet throws when this script's own
# -ExecutionPolicy Bypass overrides it.
Set-ItemProperty HKLM:\SOFTWARE\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell -Name ExecutionPolicy -Value RemoteSigned
foreach ($id in 'Git.Git', 'OpenJS.NodeJS.22', 'Microsoft.DotNet.SDK.10', 'Python.Python.3.12') {
  winget list --exact --id $id --accept-source-agreements > $null
  if ($LASTEXITCODE -eq 0) { continue }
  winget install --exact --id $id --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget install $id exited $LASTEXITCODE" }
}
