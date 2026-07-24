---
status: accepted
---

# Reflection where the record shape is uniform; per-game strategy where Mutagen's shape diverges

mEdit generalizes across Bethesda games (root `CLAUDE.md`), and its schema layer earns that
generality cheaply: `SchemaReflector` is ~930 lines with **zero** per-game branches. It reflects
over the `Mutagen.Bethesda.{Category}` assembly's major-record getters and turns them into tables.
This works because major records satisfy reflection's precondition — a **uniform shape** (getter
properties → columns) that varies across games only in *naming*, never in *structure*. `VmadCodec`
leans on the same fact from the other side: `AVirtualMachineAdapter`/`ScriptEntry`/`ScriptProperty`
are byte-identical, same-named types across Skyrim/FO4/Starfield, so a codec typed to one game
generalizes to the others by a namespace swap. Reflection and single-game typing are both
expressions of one property: *the shape is uniform, only the names differ*.

**Conditions (CTDA) break that precondition, and they are the first field that does.** Mutagen
models the same on-disk concept with four structurally different object graphs:

- **Oblivion / Fallout3** — a single flat `Condition`: `Function` + `First/Second/ThirdParameter`
  ints, no `Data` sub-object, no run-on, no Float/Global split.
- **Skyrim** — abstract `Condition` → `ConditionFloat`/`ConditionGlobal`, and **425 strongly-typed
  `*ConditionData` subclasses**, one per function (`GetActorValueConditionData.ActorValue`).
- **Fallout4** — abstract `Condition` → Float/Global, a **single generic** `FunctionConditionData`
  with `ParameterOne/Two Record/Number/String` resolved by a static `GetParameterTypes` table.
- **Starfield** — abstract `Condition` → Float/Global, a `ConditionDatas` container with an
  `IConditionParameters` abstraction (Creation Engine 2), different again.

Reflection can paper over different *names*; it cannot paper over different *structure*. A single
reflective condition codec would grow an internal case per game — a strategy pattern in disguise,
but slower, unsafe, and (worst) giving false confidence of generality right up until mEdit loads a
second game and it silently emits garbage. Mutagen itself signals the boundary: it publishes an
aspect interface for VMAD (`IHaveVirtualMachineAdapter`) but **none for conditions** — because
conditions are not one reflectable shape to unify.

## Decision

**Reflect (or single-game-type) where the Mutagen shape is uniform across games. Introduce a
per-game strategy only where Mutagen exposes structurally divergent object graphs for the same
concept.** Conditions are the first such concept, so they get the strategy; VMAD and reflected
major records keep the cheap path.

Concretely for conditions:

- A **game-neutral model** (`ParsedCondition` / `ParsedConditionParam`, in `Schema/`) is the shared
  currency. It is defined against the concept every game shares — the CTDA fields xEdit renders
  through its one cross-game `wbConditionToStr` routine (function, operator, ordered used
  parameters, run-on target + reference, comparison value or GLOB, AND/OR). The concept is
  provably uniform even though the source types are not; the binary is one fixed struct for all
  Creation Engine games, and Skyrim's per-function classes are Mutagen ergonomics over it.
- An **`IConditionCodec` strategy resolved by `GameCategory`** owns the Mutagen edge (parse only),
  one implementation per game. This is a deliberate exception to the "no interface for a single
  implementation" default: the multiplicity is documented and known **now** (four shapes shipped),
  not speculative. Only `Fallout4ConditionCodec` is implemented at introduction; Skyrim / Starfield
  / Gamebryo codecs are additive follow-ups, each real work.
- **Everything downstream is game-neutral and never sees a Mutagen type**: the
  `conditions`/`condition_parameters` DuckDB tables, `GetConditions`, the conflict classifier, the
  compare DTO, and the frontend `ConditionSection` all consume `ParsedCondition`.

This keeps ADR-0030's principle intact (the codec owns the Mutagen edge; index layout is the
Records context's decision) and matches the one mature cross-game Mutagen compare engine in our
references, `SFRecordCompareEngine`, which chose explicit per-game record specifications with a
first-class condition concept over any reflective/generic-payload approach.

## Why the neutral shape is low-risk

The shape is anchored on `wbConditionToStr`, the routine xEdit shares verbatim across
TES4/FO3/FNV/TES5/FO4/SF1/FO76. That routine *is* the spec for "what a condition displays as," and
it is game-independent. The parameter list is variable-length (Oblivion has three; Starfield may
carry more) rather than fixed `Param1/Param2`, so extended-parameter games map in without reshaping.
Run-on is always resolved to a value by the codec (pre-FNV games derive Subject/Target from a flag),
so the neutral model never carries a game-conditional absence.

The one honest soft spot is **parameter enum-value decoding** (`ActorValue 24 → "Health"`): Mutagen
categorizes such params as `Number` and only some games expose the decoded enum. The neutral param
carries a `TypeName` (the `ParameterType` name) alongside the raw value, so the decoder is a clean
later addition keyed on `TypeName` — likely itself per-game — that reshapes nothing.

## Consequences

- Adding condition support for a new game is *additive*: one new `IConditionCodec` implementation,
  no change to storage, classifier, DTO, or frontend.
- A game with no condition codec fails **loudly** (missing strategy), never silently mis-parses —
  the opposite of a reflective codec's failure mode.
- This ADR reinterprets issue #151's acceptance criterion "no hardcoded reference to Fallout4
  outside test fixtures": the *resolution logic, model, storage, and rendering* are game-generic;
  the Mutagen-edge parse is per-game by necessity and isolated behind the strategy. That satisfies
  the criterion's intent (adding a game is additive, not a rewrite) better than a brittle reflective
  codec would.
- The asymmetry is intentional and recorded so it is not "corrected" later in either direction:
  do **not** force the strategy onto VMAD (its shape is uniform — that would be scaffolding for a
  need that does not exist), and do **not** try to reflect conditions into one generic codec (their
  shape is not uniform — that would be a hidden per-game switch).
</content>
</invoke>
