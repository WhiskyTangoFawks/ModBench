# Lint Backend

Check C# backend for formatting violations and analyzer diagnostics. Commands from repo root.

## Two tools, two jobs

| Tool | What it checks | Auto-fix? |
| ---- | -------------- | --------- |
| `dotnet format --verify-no-changes` | Whitespace, indentation, blank lines — `.editorconfig` rules | `dotnet format` (no flag) |
| `dotnet build MEditService/MEditService.sln` | Roslynator analyzer rules + compiler warnings | Fix in source, rebuild |

Run both; clean = both exit 0 with no diagnostics.

## Step 1 — Formatting

```bash
dotnet format MEditService/MEditService.sln --verify-no-changes
```

Output format: `file(line,col): error RULE_ID: description`

If violations found, auto-fix:

```bash
dotnet format MEditService/MEditService.sln
```

Verify again. Don't manually edit whitespace — `dotnet format` is authoritative.

## Step 2 — Analyzer diagnostics

```bash
dotnet build MEditService/MEditService.sln --no-incremental 2>&1 | grep -E "warning|error" | grep -v "^Build"
```

`--no-incremental` forces full rebuild — no cached results mask violations.

Output format: `file(line,col): warning|error RULE_ID: description [project]`

`RCS` = Roslynator, `CS` = compiler. Both must be fixed — warnings not acceptable.

## Rule prefixes

| Prefix | Source | Common examples |
| ------ | ------ | --------------- |
| `RCS1xxx` | Roslynator style | Braces, trailing comma, redundant code |
| `CS0105` | Compiler | Duplicate `using` directive |
| `CS8600`–`CS8653` | Nullable | Nullable reference warnings |
| `WHITESPACE` | dotnet format | Extra spaces, wrong indent |

## Fixing a diagnostic

1. Open file at indicated line; apply the fix — message is usually self-explanatory.
2. To suppress a Roslynator rule project-wide: add to `<NoWarn>` in `.csproj`, not `#pragma` in source.
3. Re-run to confirm gone.

## What clean looks like

```
$ dotnet format MEditService/MEditService.sln --verify-no-changes
$

$ dotnet build MEditService/MEditService.sln --no-incremental 2>&1 | tail -4
Build succeeded.
    0 Warning(s)
    0 Error(s)
```
