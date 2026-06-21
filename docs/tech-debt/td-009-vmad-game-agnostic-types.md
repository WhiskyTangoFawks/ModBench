# TD-009 — VMAD indexer uses FO4-specific Mutagen types

**Status:** Open  
**Source:** `/code-review` on phase-13.1-vmad-backend-index  
**Verification:** CONFIRMED — conventions agent + efficiency/altitude agent both verified by reading Mutagen source.

---

## Problem

`VmadIndexer` and `DuckDbRecordRepository.IndexVmad` are coupled to FO4-specific Mutagen namespaces.

### FO4-specific types in use

| Type | Namespace | Used in |
|------|-----------|---------|
| `IHaveVirtualMachineAdapterGetter` | `Mutagen.Bethesda.Fallout4` | `DuckDbRecordRepository.cs:386` — `EnumerateMajorRecords<>` constraint |
| `IAVirtualMachineAdapterGetter` | `Mutagen.Bethesda.Fallout4` | `VmadIndexer.cs:37` — `IndexRecord` parameter |
| `IScriptBoolPropertyGetter` and all other `IScript*` types | `Mutagen.Bethesda.Fallout4` | `VmadIndexer.cs` — switch dispatch |
| `ScriptEntry.Flag`, `ScriptProperty.Flag` | `Mutagen.Bethesda.Fallout4` | `VmadIndexer.cs` — `FlagsString` overloads |

Mutagen generates per-game versions of each of these — they are structurally identical but type-incompatible. `Mutagen.Bethesda.Skyrim.IHaveVirtualMachineAdapterGetter` extends `ISkyrimMajorRecordGetter`; the FO4 version extends `IFallout4MajorRecordGetter`. Calling `EnumerateMajorRecords<Fallout4.IHaveVirtualMachineAdapterGetter>` on a Skyrim mod silently returns zero records.

### CLAUDE.md rule broken

> "Architecture must support all Mutagen-supported games without code changes"

### Observable failure

Loading any non-FO4 plugin causes `IndexVmad` to enumerate zero records, producing no VMAD rows in all three vmad tables. No error is logged (the LogInformation at end will say "Indexed VMAD for 0 records"). Silent data gap.

---

## Proposed fix

The game-agnostic abstraction needs to live at the point of enumeration and dispatch. Options:

**Option A — Delegate per-game VMAD walk to a game-specific adapter**  
`IVmadWalker` (game-agnostic interface) with one implementation per game. The repository holds an `IVmadWalker` injected via DI and resolved from `GameRelease`. Each walker knows its game's `IHaveVirtualMachineAdapterGetter` and calls the shared `VmadIndexer` after resolving property objects. Medium complexity; clean DI story.

**Option B — Generate VMAD types per-game and share the indexer via duck-typing**  
Use `dynamic` or reflection to enumerate records from any game mod and extract VMAD data. Low complexity but loses static safety.

**Option C — Accept FO4-only scope for VMAD until a second game is needed**  
Document the limitation, log a warning when `Initialize()` is called with a non-FO4 `GameRelease`, and skip `IndexVmad` for unsupported games. Zero engineering cost now; pays for itself when game support is actually added.

Option C is the pragmatic path until Skyrim support is on the roadmap.

---

## Scope

- `MEditService/MEditService.Core/Records/DuckDbRecordRepository.cs` — `IndexVmad`, `using Mutagen.Bethesda.Fallout4`
- `MEditService/MEditService.Core/Records/VmadIndexer.cs` — entire file
