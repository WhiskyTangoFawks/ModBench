# Tech debt — Cross-platform backend publishing

**Status: Open**
**Origin: Modbench-5** ([completed-tasks/modbench-5.md](../completed-tasks/modbench-5.md))

## Problem

Modbench-5 made the extension own the backend lifecycle and ship the backend
binary inside the `.vsix` (`build:backend` → `dotnet publish --self-contained`).
That publish is hardcoded to the **host RID `linux-x64`** only:

```jsonc
// medit-vscode/package.json
"build:backend": "dotnet publish ../MEditService/MEditService.Api/MEditService.Api.csproj -c Release --self-contained -r linux-x64 -o backend",
```

`BackendManager` already resolves the executable name per-platform
(`MEditService.Api` vs `MEditService.Api.exe` from `process.platform`), so the
*spawn* side is platform-aware — but a `.vsix` built on Linux only contains the
`linux-x64` binary. On Windows/macOS the bundled executable is absent or the
wrong architecture, so `BackendManager.start()` spawns nothing runnable (it
falls back to attach-only, and Launch mEdit fails unless a backend is already
running).

## Options to evaluate

1. **Per-platform VSIX** (`@vscode/vsce` supports `--target win32-x64` etc.):
   publish the matching RID per target and produce one `.vsix` per platform.
   Cleanest for Marketplace distribution; needs a CI matrix.
2. **Bundle all RIDs** in a single `.vsix` (linux-x64, win-x64, osx-x64/arm64)
   and pick the right subfolder at runtime. Simplest to build, but a fat package
   (~each self-contained runtime is tens of MB).
3. **Download-on-first-run**: ship no binary; on first Launch mEdit, download the
   matching published backend from a release asset. Smallest `.vsix`; adds a
   network dependency + integrity/versioning concerns.

Also decide the macOS story (arm64 vs x64) and whether framework-dependent
publish (requires a .NET runtime on the user's machine) is acceptable as a
lighter alternative to self-contained.

## Acceptance

- Building/installing the extension on Windows (at minimum) yields a working
  Launch mEdit without a pre-running backend.
- `BackendManager.executablePath` resolves to the correct per-platform binary
  actually present in the package.
