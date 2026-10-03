# Mod Management lives in the extension

Record editing is split across the extension and the C# service. Mod Management is not. Install, enable and disable, ordering, the file order conflict index, deploy and purge, and game-path resolution all live in the extension, in TypeScript. That work is file, HTTP and JSON work, which Node does natively. The trees and the status bar are already in the extension. A C# home would be a chatty HTTP API around UI-adjacent bookkeeping. The editing backend stays a pure Mutagen and DuckDB record service.

## Consequences

- **The extension reads no plugin binary and writes no record.** A plugin's masters come from the backend, so two views never disagree over them.

## Alternatives rejected

- **Mod management in the C# backend.** Nothing to reuse from the Mutagen and DuckDB core, and a hardlink P/Invoke is strictly harder than Node's native call.
- **A separate C# mod-manager service.** A second process, HTTP API and OpenAPI client for pure file work.
