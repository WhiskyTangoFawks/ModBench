# Phase 16.2 — Create / Copy-as-Override / Delete Placed Objects

**Status: Complete** · Parent: [phase-16](phase-16.md) · Depends on: 16.1 · **Model: Opus**

*Goal: the standard record operations — create, copy-as-override, delete — work on placed objects
(REFR/ACHR), which live structurally inside a cell's Persistent/Temporary GRUP rather than a
top-level group (ADR-0023).*

The **spike is done** (`PluginWriterPlacedSpikeTests`): the reflection-driven cell-override + placed
construction mechanism is proven to round-trip through a save, game-agnostically. This sub-phase
builds the three writer paths, the staging plumbing, the read overlay, and the frontend on top of it.
Broken into four TDD-first sub-phases.

---

## Sub-phases

| Phase | Goal | Depends on | Model |
| ----- | ---- | ---------- | ----- |
| [16.2.1](phase-16.2.1.md) | **Writer generalization** — copy-as-override + delete placed branches in `PluginWriter`; hand the writer a typed link cache from the production save path | spike | Opus |
| [16.2.2](phase-16.2.2.md) | **Staging plumbing** — `pending_changes` placement columns; `GetPlacement` repo lookup; `EditOrchestrator` placed paths (`CreatePlacedRecord`, copy/delete capture placement) | 16.2.1 | Opus |
| [16.2.3](phase-16.2.3.md) | **Walk overlay** — `GetCellReferences` surfaces pending-created/copied refs under their cell, hides pending deletes | 16.2.2 | Sonnet |
| [16.2.4](phase-16.2.4.md) | **Frontend** — create-placed endpoint + API regen; create/copy/delete context actions on cell/group/placed nodes | 16.2.3 | Sonnet |

16.2.1 and 16.2.2 are the risk; once 16.2.2 lands the backend contract is stable for 16.2.3/16.2.4.

---

## Shared decisions (apply across sub-phases)

- **Dispatch on `RecordType ∈ {refr, achr}` + `ParentCell != null`.** The writer reads
  `ParentCell`/`PlacementGroup` straight off the in-memory `PendingChange`, so each writer path is
  TDD-able with hand-constructed changes (like the spike) independent of the DB columns.
- **Typed link cache.** `GetOrAddAsOverride` exists only on `ILinkCache<TMod,TModGetter>`; the session
  builds an untyped cache. The production save path builds a typed cache via reflection over the
  game's mod types (all-games, like `SchemaReflector`) and passes it into `SaveAsync`.
- **Construction** via `MajorRecordInstantiator.Activator(formKey, release, getterType)` — public,
  cached, no NonPublic-ctor reflection (avoids the S3011 the repo enforces).
- **Copy/delete reuse the existing endpoints** (`/records/{fk}/copy-to/{target}`, `/records/delete`);
  the orchestrator captures placement internally, so only **create** needs a new endpoint.
- **Placement is structural, not a field** — it rides on the `PendingChange` (`ParentCell`/
  `PlacementGroup`), never the reflected record table.

---

## Proof

All four sub-phases complete. `dotnet test`: **740 passing** (RealGameLoadTests excluded — intermittent
HTTP timeout flakiness documented since 16.2.1, unrelated to any sub-phase). `npm run test:unit`:
**264 passing**. `npm run test:integration`: **4 passing**. `npm run build`: clean. See each
sub-phase for per-phase proof detail. Batch commit: *see phase-16.md*.
