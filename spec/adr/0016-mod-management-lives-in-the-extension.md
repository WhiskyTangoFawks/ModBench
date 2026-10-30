# Mod Management lives in the extension

Record editing is split across the extension and the C# service. Mod Management is not. Install, enable and disable, ordering, the file order conflict index, deploy and purge, game-path resolution, the manifest, the restore from it and a mod's status against it all live in the extension, in TypeScript. That work is file, HTTP and JSON work, which Node does natively. The trees and the status bar are already in the extension. A C# home would be a chatty HTTP API around UI-adjacent bookkeeping. The editing backend stays a pure Mutagen and DuckDB record service, and a source mod's build in it is compile and pack.

## Consequences

- mEdit interprets no manifest. The extension hands build and init what they need as values, and a build file a commit must hold as bytes. Each reads what it is handed only to write it, and answers with what it made. The extension records a source mod's manifest from that answer.

## Alternatives rejected

- Mod management in the C# backend. Nothing to reuse from the Mutagen and DuckDB core, and a hardlink P/Invoke is strictly harder than Node's native call.
- A separate C# mod-manager service. A second process, HTTP API and OpenAPI client for pure file work.
- The manifest and the restore from it in mEdit beside compile, the extension handing it each mod's installation files as state. A mod's status needs a file's hash and the hash its package holds, and only the extension holds the second, so mEdit keeps a copy of it, and a second archive reader and a second hash store follow.
