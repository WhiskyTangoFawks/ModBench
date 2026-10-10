$failed = @()
function Gate($name, $dir, $command) {
  Write-Host "=== $name ==="
  Push-Location $dir
  $global:LASTEXITCODE = 0
  try { Invoke-Expression $command }
  catch { Write-Host $_; $global:LASTEXITCODE = 1 }
  if ($LASTEXITCODE -ne 0) { $script:failed += $name }
  Pop-Location
}

$lock = (Get-FileHash modbench/package-lock.json).Hash
if (-not (Test-Path modbench/node_modules/.lock-hash) -or (Get-Content modbench/node_modules/.lock-hash) -ne $lock) {
  Gate 'npm ci' modbench 'npm ci'
  if ($LASTEXITCODE -eq 0) { Set-Content modbench/node_modules/.lock-hash $lock }
}
Gate 'Backend format' MEditService 'dotnet format --verify-no-changes'
Gate 'Backend build' MEditService 'dotnet build -v minimal'
Gate 'Backend tests' MEditService 'dotnet test -v minimal'
Gate 'Frontend lint' modbench 'npm run lint'
Gate 'Frontend build' modbench 'npm run build'
Gate 'Frontend unit tests' modbench 'npm run test:unit'
Gate 'Frontend integration tests' modbench 'npm run test:integration'
Gate 'Package' . '& .claude/skills/windows-vm/package-check.ps1'

if ($failed) { Write-Host "=== Windows gates FAILED: $($failed -join ', ') ==="; exit 1 }
Write-Host '=== All Windows gates passed ==='
