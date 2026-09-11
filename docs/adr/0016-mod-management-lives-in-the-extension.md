# Mod Management lives in the extension

Record editing is split across the extension and the C# service. Mod Management is not: install,
enable and disable, ordering, the file conflict index, hardlink deploy and purge, and game-path
resolution all live in the extension, in TypeScript. It is file, HTTP and JSON work, Node provides
hardlinks natively, and the trees and status bar are already there, so a C# home would be a chatty
HTTP API around UI-adjacent bookkeeping. The editing backend stays a pure Mutagen and DuckDB record
service.

## Strategic invariants

1. **The extension parses no plugin binary.** A plugin's declared masters, and which plugins load
   with no `plugins.txt` line, come from the backend through the generated client, so there is one
   master verdict and no second signal for two views to disagree over.
   `pluginBinaryScan.test.ts` is the gate.
2. **Mod Management reaches the backend only with plugin files at physical paths.** It never
   sends a mod, a modlist or a profile
   ([ADR-0013](0013-mod-management-hands-editing-the-load-order.md)),
   and it never touches git or a record.

## Alternatives rejected

- **Mod management in the C# backend.** Nothing to reuse from the Mutagen and DuckDB core, and a
  hardlink P/Invoke is strictly harder than Node's native call.
- **A separate C# mod-manager service.** A second process, HTTP API and OpenAPI client for pure
  file work.
