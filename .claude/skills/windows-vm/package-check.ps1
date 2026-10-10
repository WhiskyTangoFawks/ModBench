Set-Location (Join-Path $PSScriptRoot '..\..\..\modbench')

Remove-Item *.vsix -ErrorAction SilentlyContinue
npm run package
if ($LASTEXITCODE) { throw "npm run package exited $LASTEXITCODE" }
$vsix = Get-Item *-win32-x64-*.vsix -ErrorAction Stop

# The VS Code the integration suite downloads; a .vsix built for another platform is refused at install.
$code = Get-ChildItem "$env:LOCALAPPDATA\modbench\vscode-test" -Recurse -Filter code.cmd -ErrorAction Stop | Select-Object -First 1
$extensions = Join-Path $env:TEMP 'modbench-package-check'
Remove-Item -Recurse -Force $extensions -ErrorAction SilentlyContinue
& $code.FullName --extensions-dir $extensions --install-extension $vsix.FullName
if ($LASTEXITCODE) { throw "installing $($vsix.Name) exited $LASTEXITCODE" }

# Where bundledBackendPath looks: beside the bundle's out folder.
$installed = Get-ChildItem $extensions -Directory -Filter 'whiskytangofawks.modbench-*' | Select-Object -First 1
$backend = Join-Path $installed.FullName 'backend\MEditService.Http.exe'
if (-not (Test-Path $backend)) { throw "$($vsix.Name) carries no backend at $backend" }

$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$probe.Start()
$port = $probe.LocalEndpoint.Port
$probe.Stop()
$process = Start-Process $backend -ErrorAction Stop -ArgumentList '--urls', "http://localhost:$port" -PassThru -WindowStyle Hidden
try {
  $deadline = (Get-Date).AddSeconds(60)
  while ($true) {
    try { Invoke-RestMethod "http://localhost:$port/health" | Out-Null; break }
    catch { if ((Get-Date) -gt $deadline) { throw "the bundled backend did not answer /health within 60 s" } }
    Start-Sleep -Milliseconds 500
  }
}
finally {
  Stop-Process $process -Force
}
Write-Host "$($vsix.Name) installs, and its bundled backend answers"
