# Multi-Game Enablement

**Status: In Specification**

*Goal: turn the game-agnostic architecture (Phase M) into actual support for non-FO4 games — Skyrim, Starfield, Oblivion — so a load order from any Mutagen-supported game indexes, displays, and edits correctly.*

Phase M threaded `GameRelease` through the stack and made the schema/indexing layers reflection-driven so they work for any game without per-game code. This task is the *enablement* of that capability: adding the runtime dependencies, wiring the UI, and closing the remaining game-coupled gaps that the FO4-only build has let us get away with.

## Prerequisites

- [ ] Add Mutagen NuGet packages: `Mutagen.Bethesda.Skyrim`, `Mutagen.Bethesda.Starfield`, `Mutagen.Bethesda.Oblivion`. Today only `Mutagen.Bethesda.Fallout4` is referenced ([MEditService.Core.csproj](../../MEditService/MEditService.Core/MEditService.Core.csproj)), so a non-FO4 load fails at the Mutagen parse layer before any of our code runs.
- [ ] Extension game-picker wiring — session wizard surfaces game selection; `--game` already parses on the backend ([CliArgs.cs](../../MEditService/MEditService.Api/CliArgs.cs)).
- [ ] Exercise the env-gated `RealInstallSmokeTests` against real Skyrim/Starfield installs (its `CandidateGames` already lists them).

## Game-coupling findings

A running list of code that compiles and works only because the build is FO4-only. Each must be resolved before its game is supported. Add to this list whenever a new coupling is discovered.

### F-1 — VMAD indexer is bound to FO4 Mutagen types

**Found:** `/code-review` on phase-13.1-vmad-backend-index. Verified against Mutagen source.

`VmadIndexer` and `DuckDbRecordRepository.IndexVmad` only handle FO4. Mutagen generates VMAD types **per-game** with no shared Core base — structurally identical, type-incompatible:

| Type | Used in |
|------|---------|
| `IHaveVirtualMachineAdapterGetter` | [DuckDbRecordRepository.cs:566](../../MEditService/MEditService.Core/Records/DuckDbRecordRepository.cs#L566) — `EnumerateMajorRecords<>` constraint (`using Mutagen.Bethesda.Fallout4` at line 10) |
| `IAVirtualMachineAdapterGetter` | [VmadIndexer.cs:32](../../MEditService/MEditService.Core/Records/VmadIndexer.cs#L32) — `IndexRecord` parameter |
| `IScriptBoolPropertyGetter` and all other `IScript*` getters | [VmadIndexer.cs](../../MEditService/MEditService.Core/Records/VmadIndexer.cs) — `AppendProperty` switch dispatch |
| `ScriptEntry.Flag`, `ScriptProperty.Flag` | [VmadIndexer.cs](../../MEditService/MEditService.Core/Records/VmadIndexer.cs) — `FlagsString` overloads |

**Two coupling points, not one:**
1. **Enumeration** — `EnumerateMajorRecords<Fallout4.IHaveVirtualMachineAdapterGetter>` on a non-FO4 mod returns zero records (the FO4 interface extends `IFallout4MajorRecordGetter`; a Skyrim mod has none).
2. **Dispatch** — the `AppendProperty` switch matches FO4-namespaced `IScript*Getter` interfaces. Even with enumeration fixed, a Skyrim property would fall through every case to `default` and log "Unknown VMAD property type."

**Symptom once Skyrim is loadable:** zero VMAD rows in all three vmad tables; no error, just "Indexed VMAD for 0 records." Not reachable today (no non-FO4 package), so it is latent, not an active bug.

**Design decision (open):** *reflection vs. strategy pattern.*
- **Reflection** — generalize `VmadIndexer` to dispatch on `GetType().Name` (e.g. `"ScriptBoolProperty"`) with reflective value accessors, and resolve the per-game `IHaveVirtualMachineAdapterGetter` for enumeration. This is the codebase's established precedent: [`PlacementWalker`](../../MEditService/MEditService.Core/Records/PlacementWalker.cs) and `SchemaReflector` both walk per-game record graphs via reflection on shared names, explicitly to avoid N near-identical per-game classes (see [ADR-0023](../adr/0023-placed-objects-indexed-with-placement-side-tables.md)). Cost: loses static typing across VMAD's rich type switch.
- **Strategy pattern** — one `IVmadWalker` per game resolved from `GameRelease`. Keeps static typing but produces ~3 implementations differing only by namespace, exactly the duplication reflection was adopted to avoid. Note the original tech-debt write-up's "shared VmadIndexer + per-game walker" framing was incomplete: the indexer's switch is itself FO4-typed, so it cannot be shared as-is under a strategy approach.

Lean: reflection, for consistency with the rest of the indexing layer. Confirm when the work is scheduled.

**Scope:** [DuckDbRecordRepository.cs](../../MEditService/MEditService.Core/Records/DuckDbRecordRepository.cs) (`IndexVmad`, the `Mutagen.Bethesda.Fallout4` using) · [VmadIndexer.cs](../../MEditService/MEditService.Core/Records/VmadIndexer.cs) (entire file).

## Proof

*To be filled in on completion.*
