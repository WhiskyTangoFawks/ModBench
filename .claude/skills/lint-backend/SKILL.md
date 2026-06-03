# Lint Backend

Check the C# backend for formatting violations and analyzer diagnostics. All commands run from the repo root (or prefix paths accordingly).

## Two tools, two jobs

| Tool | What it checks | Auto-fix? |
|------|---------------|-----------|
| `dotnet format --verify-no-changes` | Whitespace, indentation, blank lines, newlines — rules from `.editorconfig` | `dotnet format` (no flag) |
| `dotnet build MEditService/MEditService.sln` | Roslynator.Analyzers rules + compiler warnings — semantic code quality | Fix in source, then rebuild |

Run both. A clean lint means both exit 0 with no diagnostics.

## Step 1 — formatting

```bash
dotnet format MEditService/MEditService.sln --verify-no-changes
```

**Output format:**

```
/path/to/File.cs(41,29): error WHITESPACE: Fix whitespace formatting. Delete 1 characters.
```

Each line is: `file(line,col): error RULE_ID: description`.

**If violations are found**, auto-fix them:

```bash
dotnet format MEditService/MEditService.sln
```

Then verify again to confirm clean. Do not manually edit whitespace — let `dotnet format` apply the fix; it is authoritative.

## Step 2 — analyzer diagnostics

```bash
dotnet build MEditService/MEditService.sln --no-incremental 2>&1 | grep -E "warning|error" | grep -v "^Build"
```

`--no-incremental` forces a full rebuild so no cached results mask new violations.

**Output format:**

```
/path/to/File.cs(12,5): warning RCS1001: Add braces to if statement. [/path/to/Project.csproj]
```

Each line is: `file(line,col): warning|error RULE_ID: description [project]`.

**RCS`xxxx`** prefixes are Roslynator rules. **CS`xxxx`** prefixes are compiler diagnostics. Both must be fixed — warnings are not acceptable.

## Reading a diagnostic

| Rule prefix | Source | Common examples |
|------------|--------|-----------------|
| `RCS1xxx` | Roslynator style | Braces, trailing comma, redundant code |
| `RCS1NNN` | Roslynator | Simplify null check, use `var`, add/remove modifier |
| `CS0105` | Compiler | Duplicate `using` directive |
| `CS8600`–`CS8653` | Nullable | Nullable reference warnings |
| `WHITESPACE` | dotnet format | Extra spaces, wrong indent |

## Fixing a diagnostic

1. Open the file at the indicated line.
2. Apply the change described — the message is usually self-explanatory.
3. For Roslynator rules you disagree with project-wide, suppress in a `<NoWarn>` in the relevant `.csproj`, not with `#pragma` in source.
4. Re-run the relevant tool to confirm the diagnostic is gone before moving on.

## What clean looks like

```
# dotnet format exits 0, no output
$ dotnet format MEditService/MEditService.sln --verify-no-changes
$

# dotnet build exits 0 with zero warnings
$ dotnet build MEditService/MEditService.sln --no-incremental 2>&1 | tail -4
Build succeeded.
    0 Warning(s)
    0 Error(s)
```

Both of these conditions must hold before lint is considered passing.
