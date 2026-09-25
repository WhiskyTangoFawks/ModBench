---
name: regenerate-api
description: How to regenerate TypeScript API client api.ts from OpenAPI spec. Use when you need to regenerate the API.
---

# Regenerate api.ts

From the repo root (`git rev-parse --show-toplevel`):

```bash
bash .claude/skills/validate/check-api-drift.sh --write
```

It builds this checkout's backend and starts it on a free loopback port, so it is always fresh
and never another worktree's or a developer's backend. It then writes
`modbench/src/wire/generated/api.ts` with the pinned `openapi-typescript` and stops only the
backend it started. Done when it prints `api.ts regenerated`. A build or boot failure prints the
backend's output instead. Commit api.ts with the C# changes.

`npm run generate-api` targets a backend a developer already runs on `:5172`.
