# Validate

After any task. Stop at first failure and fix before continuing.

## Scope

```bash
git diff --name-only HEAD && git diff --name-only --cached
```

Backend = `MEditService/**/*.cs` | Frontend = `medit-vscode/**/*.ts|tsx`, `package.json` | API = `src/generated/api.ts`

## Gates

| Gate | Run when | How |
|------|----------|-----|
| 1 — Simplify | Always | `/simplify` |
| 2 — Diagnostics | Always | `mcp__ide__getDiagnostics` — resolve any new errors before continuing |
| 3 — Backend lint | Backend | `/lint-backend` |
| 4 — Backend tests | Backend | `cd MEditService && dotnet test -v minimal` |
| 5 — Frontend lint | Frontend | `cd medit-vscode && npm run lint` |
| 6 — Frontend tests | Frontend or api.ts | `cd medit-vscode && npm run test:unit && npm run test:integration` |
| 7 — Mutation tests | Core `*.cs`, after Gate 4 | `cd MEditService && bash ../.claude/skills/mutation-test/run.sh` |
| 8 — Code review | Always | `/code-review` |

Config/docs only → skip gates 2–7.
Gate 7 survivors → triage per `/mutation-test`.
Can't pass a gate → document why; don't skip silently.

## Static analysis notes

- Gate 2 (`mcp__ide__getDiagnostics`) only sees open files — it's a quick check, not exhaustive.
- C# analyzer violations (Roslynator, SonarAnalyzer) surface during `dotnet build` via `EnforceCodeStyleInBuild=true`; Gate 4 catches them.
- Gate 5 (`npm run lint`) is the exhaustive ESLint check; the VS Code ESLint extension only runs on open files.
