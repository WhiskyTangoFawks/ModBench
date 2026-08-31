# Inventory: every compile-time `Mutagen.Bethesda.Fallout4` binding in `MEditService`

Research spike for #162, split out as #598. Read-only — no production code changed by this
document. Answers #162's own open questions (the VMAD shape check) and gives it real numbers to
design a seam from.

## Scope and method

**Candidate set:** `grep -rn "Fallout4" MEditService/MEditService.Core MEditService/MEditService.Api --include=*.cs --include=*.csproj` — **66 lines**, across **22 files** (21 in `MEditService.Core`, one `.csproj`; zero in `MEditService.Api`, confirmed empty). Tests excluded per AC1.

**Why this grep is exhaustive, not a sample.** A C# file can bind to a type in `Mutagen.Bethesda.Fallout4` exactly four ways: an explicit `using` directive, a fully-qualified name, a `using Alias = ...`, or an implicit/global using declared in project config. The first three all contain the literal substring `Fallout4` in the file itself. The fourth was checked and ruled out: neither `MEditService.Core.csproj` nor `MEditService.Api.csproj` nor `Directory.Build.props` declares any `<Using Include=...>` MSBuild item (`ImplicitUsings` is enabled, but that SDK feature only injects a fixed set of BCL namespaces — `System`, `System.Linq`, etc. — never a third-party one), and no `GlobalUsings.cs` file exists anywhere in the tree. So every possible binding mechanism is covered by the literal-text grep; the remaining work is classifying each of the 66 hits as a real binding, a comment/prose mention, or (one case) a vestigial unused `using`.

**AC1 verification, stated as two numbers:** grep line count **66** ↔ table accounting **66** (every row below cites its own file's exact line numbers from the grep output; no hit is silently dropped or merged across files). File count **22** ↔ table row count **22**, one row per file/binding-site.

## The table

| # | File | What it uses from `Mutagen.Bethesda.Fallout4` | Why | Class |
|---|---|---|---|---|
| 1 | `Schema/VmadCodec.cs` (L3) | `ScriptProperty`, `ScriptEntry`, `IHaveVirtualMachineAdapter`, `IAVirtualMachineAdapter` | Hand-written VMAD parse/apply engine (ADR-0030) | **(c)** |
| 2 | `Schema/Fallout4ConditionCodec.cs` (L5, 15, 316) | `IFormLinkGetter<IFallout4MajorRecordGetter>`, `FunctionConditionData`, `Condition`/`ConditionFloat`/`ConditionGlobal` | FO4's condition-shape codec behind `IConditionCodec` (ADR-0032) | **(d)** |
| 3 | `Serialization/RecordTextCodecGeneratorSeed.cs` (L1, 34, 54, 59, 87, 89, 116, 125, 139, 150) | `IFallout4ModGetter`, `IFallout4Mod` | Source-generator bootstrap seed — must be a concrete mod-shaped type per the generator's own detector | **(c)** |
| 4 | `Serialization/EmbedCustomizations.cs` (L1) | `ICellGetter`, `IWorldspaceGetter` (`CellEmbedCustomization`, `WorldspaceEmbedCustomization`) | Spriggit embed-slot customization. **Naming note:** the ticket calls this site `SpriggitEmbedCustomizations` — no file or class of that name exists; the real file is `EmbedCustomizations.cs`, containing two classes. Flagged explicitly so #162's author doesn't go looking for a file that isn't there. | **(c)**/**(d)** — the interfaces are per-game-generated (c), but *which* slots to embed (`Cell.{Persistent,Temporary,Landscape,NavigationMeshes}`, `Worldspace.TopCell`) mirrors Spriggit's own per-game customization packages and is a hand-picked editorial list, not something reflection alone resolves — that part is (d) |
| 5 | `Edits/RecordFieldWriter.cs` (L4) | `IHaveVirtualMachineAdapter` (write-side cast) | Field-write dispatch's VMAD branch | **(c)** |
| 6 | `Queries/RecordDocumentCodecs.cs` (L8) | `IHaveVirtualMachineAdapterGetter` (read-side) | VMAD detection when reconstituting a document | **(c)** |
| 7 | `Records/PluginIngest.cs` (L10, 352) | `IHaveVirtualMachineAdapterGetter` | VMAD detection during index ingest | **(c)** |
| 8 | `Source/TrackService.cs` (L6, 61, 208, 267, 268, 283, 285, 350) | `IFallout4Mod`, `IFallout4ModGetter`, `Fallout4Mod.CreateFromBinary`, `Fallout4Release.Fallout4` | Track's write-then-recompile-and-diff verification — needs the concrete per-game binary writer | **(c)** |
| 9 | `Source/ModelIdentity.cs` (L4, 27, 86, 121, 140, 155, 186, 189, 193, 221) | `IFallout4Mod`, `IFallout4ModHeaderGetter`, `Fallout4ModHeader.Mask` | Header-divergence comparison after `TrackService`'s recompile | **(c)** — note: the file's own comment already reaches for `ILoquiObjectGetter` as "the narrowest type both share," i.e. a game-generic base may already be one property lookup away; worth checking first when this is picked up |
| 10 | `Edits/SpatialContainerMint.cs` (L5, 18, 44, 77, 95) | `Fallout4Mod`, `ToFallout4Release()` | Builds a synthetic minimal mod for worldspace-placement mint | **(c)** |
| 11 | `Schema/ConditionCodecRegistry.cs` (L13) | constructs `Fallout4ConditionCodec` | The `GameCategory`-keyed registry — **not itself a Mutagen-typed binding**; this is the existing composition-root precedent #162's seam should mirror | *(infrastructure, not a-d)* |
| 12 | `MEditService.Core.csproj` (L18, 30) | `PackageReference Include="Mutagen.Bethesda.Fallout4" Version="0.53.1"` | The assembly reference itself — the root every other row depends on | *(infrastructure, not a-d)* |
| 13 | `Queries/Models.cs` (L286) | `string GameRelease = "Fallout4"` | A DTO's default parameter **value** (a string literal), not a type/assembly binding — different in kind from every other row, listed because it's still a de-facto single-game assumption relevant to a multi-game milestone | *(data default, not a-d)* |
| 14 | `Schema/SchemaReflector.cs` (L153, 902, 990, 997, 1488, 2280) | none — comment-only mentions | **Zero compile-time FO4 dependency.** Reflects over `Mutagen.Bethesda.{category}` at runtime via `Assembly.Load`/`Type.GetType`, keyed by `GameRelease.ToCategory()` | **(a), already in production** |
| 15 | `Serialization/RecordTextCodec.cs` (L27, 339, 352, 360, 500) | none — comment-only mentions | **Zero compile-time FO4 dependency.** Resolves `Mutagen.Bethesda.{category}.{category}MajorRecord_Serialization` by reflection, same pattern as SchemaReflector | **(a), already in production** |
| 16 | `Serialization/RecordTextCodecCustomization.cs` (L7, 42) | none — comment-only mentions | Builds on `Mutagen.Bethesda.Serialization.Customizations.ICustomize`, fully game-generic | *not a binding* |
| 17 | `Schema/ParsedCondition.cs` (L9) | none — comment-only mention | The neutral condition DTO (ADR-0032) — carries no Mutagen type at all; exactly the shared-currency shape the seam should keep targeting | *not a binding* |
| 18 | `Records/PlacementWalker.cs` (L163) | none — comment-only mention | Describes `Fallout4Group<T>`'s shape in prose; no such type used in code | *not a binding* |
| 19 | `Edits/RecordEditService.cs` (L259, 583) | none — comment-only mentions | "(FO4 today)" and an example master filename in prose | *not a binding* |
| 20 | `Source/GitBlobHash.cs` (L27) | none — comment-only mention | Example filename (`Fallout4.esm`) in a doc comment | *not a binding* |
| 21 | `Source/PluginDiagnosis.cs` (L39) | none — comment-only mention | Describes an exception `Fallout4Mod.CreateFromBinary` throws; no reference in this file's own code | *not a binding* |
| 22 | `Records/DuckDbRecordIndex.cs` (L16) | `using Mutagen.Bethesda.Fallout4;` present, **but no FO4-specific symbol used anywhere in the file** | Read the full 1,481-line file end to end: every Mutagen-typed symbol it touches (`IModGetter`, `IMajorRecord`, `GameRelease`, `FormKey`) is game-generic. "Cell"/"Worldspace" appear only in a comment header and as SQL/string literals, never as a type. **Vestigial import, not a live binding** — likely a leftover from refactoring. Left in place; AC4 (no production code changes) forbids removing it here, and it's a one-off, not a pattern (see note below). | *not a binding (vestigial `using`)* |

**On the two premise deviations (both are the deliverable, not a problem with it):** row 22 (`DuckDbRecordIndex`) turned out to carry no live binding despite the ticket naming it, and row 4's ticket-given name (`SpriggitEmbedCustomizations`) doesn't exist verbatim — the real site is `EmbedCustomizations.cs`. Both are called out explicitly in their rows above. **On vestigial-import prevalence:** row 22 is the only vestigial hit found in this inventory (21 of 22 files/sites either carry a live binding or are honest comment-only prose) — one dead `using` is noise, not a pattern, so no follow-up ticket is warranted from this alone.

## Counts per class

| Class | Count | Sites |
|---|---|---|
| **(a)** reflect over `Mutagen.Bethesda.{Category}` at runtime | **2**, already in production | `SchemaReflector`, `RecordTextCodec` |
| **(b)** uniform-interface strategy | **0** in production; **1 designed, not built** | Conditions, Skyrim+Starfield via `IConditionParametersGetter` (#162's own resolved design) |
| **(c)** generated-per-game (mechanical, one seed/type per game assembly) | **9** | `VmadCodec`, `RecordTextCodecGeneratorSeed`, `EmbedCustomizations`, `RecordFieldWriter`, `RecordDocumentCodecs`, `PluginIngest`, `TrackService`, `ModelIdentity`, `SpatialContainerMint` |
| **(d)** genuinely FO4-only feature | **1** solid (`Fallout4ConditionCodec`, by #162's own resolved design), plus `EmbedCustomizations`' slot-list and `Models.cs`'s default carrying a lesser flavor of the same thing | see rows 2, 4, 13 |
| Not a binding (comment-only prose, or one vestigial `using`) | **7** | rows 16–22 |
| Infrastructure (registry / package reference — hosts the above, isn't itself classified) | **2** | `ConditionCodecRegistry`, the `.csproj` `PackageReference` |

**The single most useful number here for #162:** class (a) is not hypothetical — it is **already shipping in production** in two places (`SchemaReflector`, the whole reflected-field pipeline; `RecordTextCodec`, the whole per-record serialize/deserialize door), with genuinely **zero** compile-time FO4 dependency in either. Whatever seam #162 designs, it is extending a pattern that already works at scale (~586 record types, ADR-0005), not inventing one.

## VMAD shape check

**Is `IHaveVirtualMachineAdapterGetter`'s shape uniform across FO4/Skyrim/Starfield? Yes.**

Citation — `references/Mutagen/Mutagen.Bethesda.{Fallout4,Skyrim,Starfield}/Interfaces/Aspect/IHaveVirtualMachineAdapter.cs`, all three declare, independently:

```csharp
public interface IHaveVirtualMachineAdapterGetter : I<Game>MajorRecordGetter
{
    IAVirtualMachineAdapterGetter? VirtualMachineAdapter { get; }
}
```

Same single member, same name, same declared type, in every game — each rooted only in that game's own `I<Game>MajorRecordGetter` ancestor. `ScriptEntry`/`ScriptProperty`/`IAVirtualMachineAdapter` are likewise independently generated per game under `Records/Common Subrecords/`, with matching shapes. There is **no single shared cross-game type** behind these names (each game's `IHaveVirtualMachineAdapterGetter` is its own distinct interface) — so this is class **(c) generated-per-game**, not class (b).

**(b) vs (c), stated explicitly because the distinction is the whole point for #162:** (b) uniform-interface would mean one shared type all three games' concrete records implement, callable through one static reference with no per-game branch at all — that's not what exists here. (c) generated-per-game means three independently-generated, structurally-identical types, requiring one seed/namespace-swap per game — which *is* what exists here, and (per ADR-0032, which already reaches this conclusion independently: *"a codec typed to one game generalizes to the others by a namespace swap"*) is cheap precisely because the swap is mechanical. (b) would become available only if some caller started reflecting on member shape/name across the three rather than depending on any one game's concrete interface — nothing in this codebase does that today, so (b) is a live *option* for VMAD, not the current mechanism.

This also directly answers the question #162 itself left open ("verify `VmadCodec`/`VmadIndexer`'s cross-game shape before deciding whether it needs the same two-strategy split [as Conditions] or is already uniform"): **VMAD does not need a two-strategy split.** Unlike Conditions — where FO4's `FunctionConditionData` and Skyrim/Starfield's per-function subclass model are genuinely different object graphs (ADR-0032's four-way breakdown) — VMAD is the *same* generated shape in all three games. One mechanical per-game seed (mirroring `RecordTextCodecGeneratorSeed`'s existing pattern) is enough; no uniform-interface fallback strategy is needed the way Conditions needs one for Skyrim+Starfield.

## What the minimal seam looks like (proposed, not built)

One shape, reused per concern, mirroring the composition root that already exists (`ConditionCodecRegistry`):

**A `GameCategory`-keyed registry per concern**, each entry built from one of the three live mechanisms above, chosen by what that concern's Mutagen shape actually is — never by copying a strategy that happened to work for a different concern:

- **VMAD** (`VmadCodec` + its three call sites, `RecordFieldWriter`/`RecordDocumentCodecs`/`PluginIngest`): stays class (c) — add a `VmadCodecSeed`-style per-game seed (same shape as `RecordTextCodecGeneratorSeed` already proves out for the whole schema) and a small registry the three call sites resolve through instead of hardcoding `Mutagen.Bethesda.Fallout4`'s `IHaveVirtualMachineAdapter` directly.
- **Conditions** (`Fallout4ConditionCodec` behind `ConditionCodecRegistry`): already the target shape. Keep `Fallout4ConditionCodec` gated to FO4 (class d, as #162 itself concludes), and add one class-(b) `UniformConditionCodec` implementation shared by Skyrim and Starfield via `IConditionParametersGetter` — the registry already dispatches by `GameCategory`, so this is an additive entry, not a redesign.
- **Track's recompile-verify path** (`TrackService`/`ModelIdentity`/`SpatialContainerMint`): all class (c) today via direct `Fallout4Mod`/`IFallout4Mod` typing. `ModelIdentity`'s own comment already points at `ILoquiObjectGetter` as a possibly-sufficient game-generic base for the header-divergence compare — check that first; if it holds, this collapses toward class (a) with no per-game seed needed at all.
- **`EmbedCustomizations`**: the embed-slot *list* (row 4) is a genuine per-game editorial decision (class d) sitting on top of class-(c) interfaces — keep it as a small, explicit per-game table rather than trying to infer it.

**The one place game-specific pieces would bind:** a `GameCategory`-keyed registry per concern (VMAD, Conditions, recompile-verify), each constructed the way `ConditionCodecRegistry` already builds its one entry today — so extending to a second game is "add one more registry entry, one seed file, or one shared implementation," never a new dispatch mechanism.

## What this document does not do

Per AC4/scope: no code changed, no seam built, no ticket filed for the vestigial `using` in `DuckDbRecordIndex.cs` (noise, not a pattern — see the table note above), and Skyrim session support (#423, closed) is treated purely as input, not scope: #423 found the *assembly itself* unreferenced for Skyrim (`SchemaReflector.IsSupported` fails at `Assembly.Load`), which is a real second axis any seam built from this inventory will still have to answer, independent of every classification above.
