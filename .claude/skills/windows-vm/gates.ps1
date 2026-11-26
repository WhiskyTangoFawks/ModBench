$failed = @()
$clock = [System.Diagnostics.Stopwatch]::StartNew()
# #2466 resumes the merge-to-main tier and deletes this line.
Write-Host 'The merge-to-main tier is paused until epic #2450 lands: these are the branch gates.'
$env:NODE_OPTIONS = '--max-old-space-size=4096'
$env:PYTHONUTF8 = 1
$env:MEDIT_VIRTUAL_MACHINE = 'true'
$reports = Join-Path $env:TEMP 'modbench-gates'
Remove-Item -Recurse -Force $reports -ErrorAction SilentlyContinue
New-Item -ItemType Directory $reports | Out-Null

# Shows each line of a run and keeps it in a report, for a stack whose own report names no skip.
function Record($file) {
  process {
    $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
    $line
    Add-Content -Path $file -Value $line -Encoding utf8
  }
}

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
Gate 'Backend tests' MEditService 'dotnet test -v minimal --logger trx --results-directory "$reports"'
Gate 'Scripts tests' scripts 'python -m unittest discover -v --durations 0 2>&1 | Record "$reports\scripts.unittest"'
Gate 'Frontend lint' modbench 'npm run lint'
Gate 'Frontend build' modbench 'npm run build'
Gate 'Frontend unit tests' modbench 'npm run test:unit -- --reporter=default --reporter=json --outputFile.json="$reports\unit.json"'
Gate 'Frontend integration tests' modbench 'npm run test:integration 2>&1 | Record "$reports\integration.mocha"'
Gate 'Package' . '& .claude/skills/windows-vm/package-check.ps1'
Gate 'Skipped tests' . 'python .claude/skills/validate/skips.py "$reports"'
Gate 'Test times and budget' . 'python .claude/skills/validate/check_test_times.py "$reports" $clock.Elapsed.TotalSeconds 600'

if ($failed) { Write-Host "=== Windows gates FAILED: $($failed -join ', ') ==="; exit 1 }
Write-Host '=== All Windows gates passed ==='
