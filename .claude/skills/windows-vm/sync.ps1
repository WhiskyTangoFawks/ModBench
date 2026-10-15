param([string]$Stage, [string]$Work)
$ErrorActionPreference = 'Stop'
$stageRoot = (Resolve-Path -LiteralPath $Stage).Path.TrimEnd('\')
Get-ChildItem -LiteralPath $stageRoot -Recurse -File | ForEach-Object {
  $target = Join-Path $Work $_.FullName.Substring($stageRoot.Length + 1)
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { return }
  $built = Get-Item -LiteralPath $target
  if ($built.LastWriteTimeUtc -ne $_.LastWriteTimeUtc -and $built.Length -eq $_.Length -and (Get-FileHash -LiteralPath $target).Hash -eq (Get-FileHash -LiteralPath $_.FullName).Hash) {
    $_.LastWriteTimeUtc = $built.LastWriteTimeUtc
  }
}
$copied = robocopy $Stage $Work /MIR /XD node_modules bin obj out .vscode-test backend /FP /NC /NS /NDL /NJH /NJS /NP
$code = $LASTEXITCODE
$now = [DateTime]::UtcNow
foreach ($line in $copied) {
  $path = $line.Trim()
  if ($path.StartsWith("$stageRoot\", [StringComparison]::OrdinalIgnoreCase)) { $path = Join-Path $Work $path.Substring($stageRoot.Length + 1) }
  if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) { (Get-Item -LiteralPath $path).LastWriteTimeUtc = $now }
}
exit [int]($code -ge 8)
