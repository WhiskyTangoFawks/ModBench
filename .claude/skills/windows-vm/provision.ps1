$ErrorActionPreference = 'Stop'
Set-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1
# The machine's policy, written where Set-ExecutionPolicy writes it: the cmdlet throws when this script's own
# -ExecutionPolicy Bypass overrides it.
Set-ItemProperty HKLM:\SOFTWARE\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell -Name ExecutionPolicy -Value RemoteSigned
foreach ($id in 'Git.Git', 'OpenJS.NodeJS.22', 'Microsoft.DotNet.SDK.10', 'Python.Python.3.12') {
  winget list --exact --id $id --accept-source-agreements > $null
  if ($LASTEXITCODE -eq 0) { continue }
  winget install --exact --id $id --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget install $id exited $LASTEXITCODE" }
}
