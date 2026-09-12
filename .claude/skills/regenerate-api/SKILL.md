---
name: regenerate-api
description: How to regenerate TypeScript API client api.ts from OpenAPI spec. Use when you need to regenerate the API.
---

# Regenerate api.ts

`npm run generate-api` scrapes the spec from a running backend at `:5172`. A
running one is likely stale. Always kill → fresh start → regen → stop; never skip
the restart because a backend "looks up".

```bash
# kill stale backend
pkill -f "MEditService.Http" 2>/dev/null; sleep 1

# fresh start — no args needed; the web host + /health boot regardless. Detached, so the
# foreground call returns while the backend keeps running:
bash .claude/skills/validate/detached.sh start api dotnet run --project MEditService/MEditService.Http

# wait for boot (rebuilds, so slow)
until curl -sf http://localhost:5172/health >/dev/null 2>&1; do sleep 1; done

# regen, then stop
cd modbench && npm run generate-api
pkill -f "MEditService.Http"
```

Paths are relative to the repo root (`git rev-parse --show-toplevel`).

- `until` hangs → compile error; check backend output.
- Leaves backend stopped. Commit api.ts with the C# changes.
