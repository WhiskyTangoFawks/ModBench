---
status: accepted
---

# C# for the backend service, TypeScript for the extension and webviews

Everything that touches Mutagen or DuckDB is C#. This is not a preference — Mutagen is a C# NuGet
library. Using it from any other language requires either a native interop layer or a process
boundary, both adding complexity for no benefit. The backend is an ASP.NET Core minimal API
running as a local process on localhost, emitting an OpenAPI spec via Swashbuckle.

VS Code extensions are TypeScript — this is the VS Code extension model, not a choice. The webview
panels (React) are also TypeScript. The frontend consumes the C# service's OpenAPI spec to
generate a fully typed API client at build time via `openapi-fetch` (`npm run generate-api`),
eliminating manual type maintenance; a gate catches drift between the generated client and the
live spec.

## Alternatives rejected

- **Python (FastAPI)** — cannot use Mutagen directly. A Python layer in front of a C# Mutagen
  service is a pure proxy: latency and a language context switch with no benefit.
- **Node.js** — same problem as Python. Also the approach zEdit took (Electron + native Node addon
  wrapping xedit-lib); zEdit is abandoned.
- **C / C++** — no justification. Mutagen is C#; C interop would be a significant maintenance
  burden.
