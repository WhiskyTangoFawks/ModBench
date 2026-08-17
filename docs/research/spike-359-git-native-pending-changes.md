# Spike #359 — git-native pending changes: findings

Throwaway prototype answering the ten falsifiable questions in #359 (eight from the
brief, Q9 from the consequences addendum, Q10 from plan review). Prototype code lives on
branch `spike-359-git-native-pending-changes` and never merges; this document and
ADR-0040 are the deliverables. All measurements from 2026-08-17 on the dev machine
(Linux, .NET 9/10 SDKs), subjects: `mEditTestSubset.esm` (768 KB, committed test data),
`AmericaRising2.esm` (20 MB, real mod), `Fallout4.esm` (316 MB, vanilla master).

## Verdict up front

**Go, in stages** (details in ADR-0040). Every load-bearing claim of the architecture
survived contact:

- Per-record text serialization is cheap, symmetric, and reachable today — no upstream PR.
- The text ledger is deterministic on the Mutagen version we already pin.
- The read model already holds multiple versions of a record without schema surgery.
- Cross-repo atomicity works as journal + prepare-then-advance, recoverable and loud.
- Merge staleness is one anti-join.
- The native SCM panel accepts our domain shape, and clicks route to the compare grid.

One serious hazard was found, and it is *upstream and version-specific*, not
architectural: **Mutagen 0.54.0 has a binary round-trip regression** (below). It blocks
adopting current Spriggit pins, not the architecture.

## Q1 — Spriggit fidelity

**Result: text-deterministic and semantically faithful on Mutagen 0.53.1 + Serialization
1.37.1; a genuine regression found in Mutagen 0.54.0.**

- **Mutagen 0.54.0 regression (new upstream finding).** Pure binary round trip
  (binary → object → binary, no text involved) *grows* FO4 weapon ObjectTemplate
  combination entries every cycle: `mEditTestSubset.esm` 767,753 → 769,026 → 770,299 B
  (+1,273 B/cycle, divergent — pass 3 kept growing; empty-Name combinations duplicate).
  Identical probe code on **0.53.1 is byte-identical** across cycles. Confirmed by clean
  A/B with only the package version flipped. No matching upstream issue found — worth
  reporting to Mutagen-Modding/Mutagen. Spriggit HEAD pins Mutagen `[0.54.0]` exactly,
  so current Spriggit inherits the defect.
  *Product implication beyond the spike:* mEdit's save path rewrites plugins through
  Mutagen. On 0.53.1 we are safe; a routine bump to 0.54.x would have made every save of
  a plugin containing such weapons silently grow it. A binary round-trip stability test
  should join the suite regardless of this spike's outcome.
- **Text stability (the property the ledger actually needs).** On 0.53.1 + 1.37.1:
  serialize → deserialize → write binary → re-serialize produced a text tree
  **identical in all 3,943 files** to pass 1. The ledger is deterministic.
- **Binary fidelity.** Rebuilt binary is the same size, semantically identical (proven
  by text stability), but not byte-identical: (a) Spriggit's deliberate omissions
  (timestamps, last-modified); (b) **record order within groups is permuted** —
  file-per-record deserialize reassembles in filename order. Order doesn't matter to the
  engine for top-level records, but it means a rebuild-from-text shows as a whole-file
  change to hash-based tools (Wabbajack manifests, #329). The normal save path builds
  the binary from in-memory objects, not from text, so reorder only appears in the
  crash-repair path.
- **Localized plugins** (vanilla masters like `Fallout4.esm`) need data-folder string
  context to serialize, and 0.53.1's resolver additionally demands a plugins.txt
  location on Linux. Mod plugins — the actual edit targets — are non-localized.
  Vendoring an override *of* a vanilla-master record stays inside the editing plugin and
  is unaffected; serializing the master itself is not something the architecture needs.

## Q2 — Touched-records-only vendoring

**Result: required, and it works. Whole-mod serialization is not a viable fallback.**

| Measurement (20 MB `AmericaRising2.esm`) | Value |
| --- | --- |
| First-edit latency: serialize 1 record + `git init` + 2 ops + commit | **160 ms** |
| — of which single-record YAML serialize | 129 ms |
| Single record text size | 2.3 KB |
| Single-record deserialize back to a Mutagen object | 55 ms, field-faithful |
| Whole-mod serialize (the rejected fallback) | **21 s**, 132,787 files, 106 MB |
| Whole-mod serialize, 768 KB subset | 2.2–3.9 s |

Diff quality: two field edits (Name + EditorID) rendered as exactly two changed YAML
lines under `git diff`. The hidden-gitdir arrangement works as designed: `GIT_DIR` under
an internal folder, worktree = the mod folder, no `.git` inside the mod, clean
`git status` through the env-var door.

## Q3 — Branch-overlay indexing

**Result: the read model already supports it; cost tracks divergence.**

The records tables are keyed `(form_key, origin, plugin)` (ADR-0036). Indexing a
branch's re-materialized records under a synthetic ref origin (`branch:agent-1`,
`participates: false`) gives coexisting committed + proposed rows with **no schema
change**; precedence is one `ORDER BY` over the origin discriminator; leaving review
mode is `Unindex(plugin, ref)` — the exact machinery ADR-0035 built for unlisted
plugins. Overlay indexing of a 1-record branch was strictly cheaper than the 201-record
committed index (cost ∝ divergence). Production would formalize a ref column rather
than overload origin, but nothing structural is missing.

Fairness note: ADR-0025's generated overlay views were never implemented — today's
pending overlay is inline `pending_changes` joins scattered per query. The comparison
baseline is those joins, and the ref-dimension read is simpler than any of them.

## Q4 — Cross-repo atomicity

**Result: journal + prepare-then-advance recovers loudly; the journal is load-bearing.**

Probe: a change set spanning two mods/two hidden-gitdir repos; phase 1 validates and
journals intent (repo list + exact content hash each ref must advance to); phase 2
advances refs; a crash injected between the two advances. Recovery replayed the journal,
detected exactly the lagging repo, completed it; if the worktree had diverged from the
journaled intent it refuses rather than completing silently. Negative control: without
the journal, nothing names the lagging repo — the half-state would be silent. The
existing `SaveTransaction`/`PreparedPluginSave` split (`ExecuteGroupSaveAsync`'s
`prepareAll` delegate) is already this shape; the journal and ref-advance are the new
parts.

## Q5 — Merge staleness

**Result: one anti-join.** Branch A renumbers race R1→R2 and merges; branch B, cut
earlier, references R1. The stale reference is caught by: references with
`source_origin = branch` whose target exists in neither merged-committed nor the branch
itself (`form_references` ⟕ `form_lookup`). Loud (returns the named record + target),
and overridable as policy — the query yields a list, the caller decides whether to
block. Production routes this through `ReferenceValidator` (ADR-0020's check, re-run
against post-merge state).

## Q6 — SCM provider shape

**Result: both granularities render; recommend the aggregate provider.** Prototyped
`vscode.scm.createSourceControl` with an aggregate provider (resource groups = working
tree + one per agent branch, resources spanning mods) and per-mod providers side by
side (`modbench.spike359Scm` on the spike branch; lint + command-parity integration
tests green). Per-mod providers each cost a header row — unusable at dozens-to-hundreds
of mods. The aggregate provider matches the domain: groups are *states of review*, not
places on disk. Resource click routing to an arbitrary command is confirmed API
behavior (`SourceControlResourceState.command`).

## Q7 — Grid as the review surface

**Result: SCM-resource-command → compare grid works; custom editors still cannot join
the native diff editor** (no such API in current VS Code docs — the webview-panel route
is not a workaround but the only route). The grid already renders a non-plugin `pending`
column; committed-vs-proposed as versions-in-time columns is a variation on
`buildColumns`/`ColumnKey`, not new machinery. What grid review loses vs text diff:
Comments API thread anchoring (review comments anchor to text lines). Mitigation: the
raw YAML diff remains available as a secondary command on the same resource, and that
surface gets Comments API anchoring for free.

## Q8 — Glossary rework (draft; CONTEXT.md untouched until the ADR is accepted)

Git-native terms adopted as-is (inventing nothing):

- **Working tree** — a mod's current proposed text state. The user's own edits are
  working-tree changes ("uncommitted changes", not "pending changes").
- **Stage / index** — git's own words; mEdit's existing "stage" maps onto them directly.
- **Commit = save** for the user's own edits (validate → apply-to-binary → advance main).
- **Branch** — a line of proposed work not in the working tree; every agent/script run
  is a branch, never checked out.
- **Merge = acceptance** of a branch, same apply step as commit.
- **Revert / restore / conflict** — git's meanings, unqualified.

Domain terms that survive because git has no word for them:

- **Change-group closure** (ADR-0017/0028) — the dependency closure that makes a set of
  changes save/merge together; git has no cross-repo dependency concept.
- **Apply-to-binary** — the build step turning accepted text into the plugin binary
  (ADR-0008 discipline lives here).
- **Vendor** — committing a Downloaded mod's pristine per-record text as the baseline,
  copy-on-write at first touch (see Mod Management's Authored/Downloaded/Modified).

Retired: "pending change" (becomes uncommitted change / branch change), "accept"
as a bespoke gesture (becomes commit/merge), the Pending Changes tree (superseded by
the SCM provider).

## Q9 — User-dirt vs agent-branch collision

Adopt git's own rule rather than inventing one: **a merge that would touch a record with
uncommitted working-tree changes refuses until the user commits or reverts their dirt**
— exactly how git refuses a merge over dirty paths. Detection is the ref-dimension
query: more than one non-committed ref holding rows for the same `(form_key, plugin)`.
Surface it in the SCM view (the resource appears in both groups) and at merge time
(loud refusal naming the records). Never auto-merge the two proposals.

## Q10 — Spriggit integration depth

**Result: use the layer under Spriggit, at the library level; confinement to the ledger
boundary is confirmed.**

- Spriggit is a thin versioning/packaging shell: its translation packages are
  *executables* the engine downloads per-version; the actual codec is
  **`Mutagen.Bethesda.Serialization`** (a Roslyn source generator) + per-game
  customizations (~10 lines we replicate). The right integration is the generator in our
  own assembly — consistent with the "Spriggit import/export" milestone's stated
  preference for library-level integration.
- **Per-record serialize/deserialize is reachable today, no upstream PR**: the generator
  emits `<Type>_Serialization` classes *into the consuming assembly* (internal there,
  public members), plus public `SerializationHelper` file-per-record utilities. The
  single-record probe (Q2) is built on exactly this.
- Version couplings measured: Serialization 1.38.6 requires Mutagen [0.54.x] (the
  regression) and a Roslyn 5.3 toolchain (.NET 10.0.4xx SDK); **1.37.1 works against
  Mutagen 0.53.1** (floor 0.51.3) and needs Roslyn ≥ 4.14 — newer than the repo's
  current 9.0.119 SDK either way. Adopting this architecture bumps the build toolchain.
  1.37.1 lacks two of Spriggit-current's customizations (`OmitUnknownGroupData`,
  `OmitUnusedConditionDataFields`) — harmless for us; we are our own writer and reader,
  and byte-compat with Spriggit-the-tool's output is a non-goal (interop remains
  possible at the folder level).
- Spriggit never serializes a delta — it serializes *state*; the delta is git's diff
  between the vendored pristine commit and the edited commit. The Modified-mod delta
  story therefore needs nothing from Spriggit beyond per-record state text, which we
  have. **The binary-diff fallback for Modified mods is unnecessary** — agentic diff
  analysis works on Modified and Authored mods alike.
- Call-site confinement (codec at the ledger boundary only) stands: nothing in the
  probes wanted Spriggit text on the wire, in queries, or in the load path.

## Recommendation — go, in stages

1. **Stage 1 (shared first step of every end state):** per-record text mirror,
   commit-on-save into hidden per-mod repos, aggregate SCM provider read-only, raw text
   diff as review surface. Pending buffer untouched. Ships durable history + native
   review immediately.
2. **Stage 2:** agent/script edits move to never-checked-out branches; merge =
   acceptance with post-merge revalidation (Q5 query via `ReferenceValidator`); ref
   dimension in the read model; grid review mode.
3. **Stage 3:** retire the bespoke pending store (`DuckDbPendingChangeService`), drift
   machinery (#333/#349/#356 lineage → rebase), exit prompts; wire-protocol rework.

Gates: pin Mutagen 0.53.x until the 0.54 regression is fixed upstream (report it);
add the binary round-trip stability test now; toolchain bump (SDK ≥ 9.0.3xx, ideally
10.x) precedes Stage 1.

Consequence dispositions the ADR must carry are in ADR-0040.
