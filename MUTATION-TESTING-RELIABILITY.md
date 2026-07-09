# Mutation testing: reliability findings (delete once actioned)

Investigation into why the analyzer-backlog refactor's mutation run surfaced 114 items,
and what would make future runs more reliable and higher-signal. Companion to
`MUTATION-TRIAGE-HANDOFF.md` (the actual triage of those 114 — in progress separately).

## 1. Confirmed bugs

### 1a. `since: main` scopes at the file level, not the diff — FIXED this session

Stryker.NET's own behavior: touching any line in a file makes every testable line in
that file eligible for mutation. There's no upstream line-diff filter. This is why 8
mechanically-refactored files produced 114 survivors instead of ~0.

**Fix applied:** `parse-report.py --diff-only` (new flag) filters an existing report
down to survivors whose lines intersect the real git diff vs `since.target`. Verified
against the actual 114-item report: `Filtered 114 file-level survivors outside the diff
(114 -> 0)` — proving all 114 are pre-existing entropy, not refactor regressions.
`run.sh --diff-only` passes it through. `SKILL.md` now documents the file-level
semantics explicitly. See commit for this session's `mutation-test` skill changes.

### 1b. `run.sh --mutant-ids` / config `mutant-id` does not exist in Stryker.NET — NOT FIXED, needs a decision

`SKILL.md`'s own recommended workflow — "🏎️ Confirm fixes with targeted runs... confirm
it with `run.sh --mutant-ids <id>`" — **is currently non-functional**. Reproduced directly:

```
dotnet stryker --help
```

lists no `--mutant-id`/`--mutant-ids` CLI option at all. Running `run.sh --mutant-ids
2204` (attempting to confirm the `PlacementWalker.cs:89` fix below) produces:

```
Stryker.NET failed to mutate your project.
The allowed keys for the "stryker-config" object are { ... } but "mutant-id" was
found in the config file
```

`run.sh`'s `--mutant-ids` branch (lines 43-55) injects `stryker-config.json`'s
`mutant-id` array — a key the installed Stryker.NET (4.14.2) schema simply rejects.
This has presumably never worked; nothing in this session's history suggests the
config schema changed recently. **Every "confirm with `--mutant-ids`" instruction in
`SKILL.md` is misleading.**

**Recommendation (needs developer decision):** remove `--mutant-ids` from `run.sh` and
the corresponding `SKILL.md` guidance entirely; the working alternative is `--file
<File>.cs` with `since` disabled (see 1c for the cost caveat), then diff the new
report's line list against the old one, or just check the specific line no longer
appears as `Survived`/`NoCoverage`.

### 1c. Direct `dotnet stryker` invocation (no PTY) fails silently — informational, `run.sh` already handles this correctly

Confirmed: running `dotnet stryker` directly (no `script -q -c` wrapping) exits 1 with
**zero output** — no exception, no log line, nothing on stdout/stderr. `run.sh`'s
comment about this ("Stryker writes to the TTY, not stdout/stderr") is accurate and its
`script -q -c` workaround is necessary, not optional. Documenting here only because it's
a sharp edge: any manual/ad-hoc Stryker invocation that skips `run.sh` will appear to
fail instantly with no diagnostic, which is confusing without this context.

### 1d. Single-file, since-disabled confirmation run did not complete inside 5 minutes — unconfirmed, needs follow-up

Attempting a legitimate targeted confirmation (`since` disabled, `mutate` restricted to
just `PlacementWalker.cs`, foreground, PTY-wrapped) did not produce a report or any
tail output within a 5-minute timeout, well past the "~60s initial run" `SKILL.md`
documents for targeted runs. No orphaned `dotnet`/`stryker` process was left behind
after the timeout (checked), and `stryker-config.json` was restored cleanly — so
nothing was left in a broken state — but the underlying slowness is unexplained. Likely
candidate: `coverage-analysis: perTest` still pays for a full test-project build +
initial full test pass regardless of how narrow `mutate` is, so "targeted" runs may
never actually be as cheap as documented. **Needs a dedicated follow-up** (time a
`--file` run against the clock, compare `perTest` vs other coverage-analysis modes)
before trusting the "confirm fixes with targeted runs" workflow for time-sensitive work.
Given 1b and 1c, the `PlacementWalker.cs:89` fix in the triage doc was instead verified
by direct reasoning + `dotnet test` (12/12 passing including the new assertions) rather
than a live mutant-kill — solid evidence, but not the workflow the skill promises.

## 2. Noise patterns observed (from the first 11 items triaged)

Distribution across all 114 items by mutator type (`parse-report.py` output, grep'd):

| Mutator | Count |
|---|---|
| Conditional mutation | 24 |
| Boolean mutation | 20 |
| Statement mutation | 16 |
| Equality mutation | 12 |
| Null coalescing mutation | 11 |
| Linq method mutation | 11 |
| Logical mutation | 10 |
| Block removal / Object initializer / Bitwise / Arithmetic | 9 |

By file, `PluginWriter.cs` (41) and `SchemaReflector.cs` (44) alone are 75% of the
total (85/114) — and both are the two most reflection-heavy, "support all Mutagen games
generically" files in the codebase. That's not a coincidence given the pattern below.

### Class A — "equivalent under an invariant Stryker can't see"

Every comparison/null-coalescing survivor triaged so far turned out to be a genuine
**equivalent mutant**, not a coverage gap, because two branches are provably equal at
exactly the point where the mutation would matter:

- `ConflictRules.cs:92` — `Severity(contribution) > Severity(generic)` → `>=`. Equal
  severity implies equal `ConflictAll` value (severities 0-2 are a bijection with the
  non-terminal enum values, and `contribution` is documented as never terminal) — so
  `>` and `>=` return the identical value whenever they'd differ in truth value.
- `EditOrchestrator.cs:158` — `continue` → no-op. On a failed `VmadPath.TryParse`, the
  out-params are forced to `""` (confirmed in source), and the following `if` matches
  by exact script name — never `""` for a real VMAD script — so the `if` can never
  fire either way.
- `EditOrchestrator.cs:529` — `committed ?? pending` operand order swapped. Only
  differs if a FormKey is simultaneously committed *and* pending-create, which the
  staged-edit data model treats as mutually exclusive by construction.

**Recommendation:** don't blanket-suppress `Equality`/`Conditional`/`Null coalescing`
mutations project-wide — that would blind real logic bugs in ordinary code, and these
mutator *types* aren't inherently low-value (this class is maybe a third of the
Equality/Conditional/Null-coalescing survivors seen so far, not all of them). Instead,
add this as a named, fast-path pattern to `SKILL.md`'s gating-question section: *"If
the two branches are providing the same value whenever they'd actually differ, given
an invariant elsewhere in the code — that's an equivalent mutant, not a gap. Look for
the invariant before assuming a test is missing."* This is a triage-speed improvement,
not a suppression.

### Class B — "reflection guard against an external library's API shape"

All 4 `TypedLinkCacheFactory.cs` survivors are `First`/`FirstOrDefault`/logical-operator
mutations inside code that reflects over Mutagen's `LinkCacheConstructionMixIn` and
assembly set. They only produce different behavior if Mutagen's own public API stops
having the shape this code assumes — not something a unit test can exercise without
literally breaking the referenced library. Given `SchemaReflector.cs` (44 survivors,
the single biggest file) does the *same* kind of generic-reflection-over-Mutagen work,
and `PluginWriter.cs` (41) very likely does too for writing edits generically, I'd
expect a meaningful fraction of the two big files' survivors to be this same class —
**to be confirmed when those files are triaged**, not assumed.

**Recommendation:** no global config suppression here either (mutator names like `Linq
method mutation` are common and often meaningful elsewhere — e.g. a real `First()` vs
`FirstOrDefault()` bug should still be catchable in non-reflection code). The
mechanism that already exists — source-level `// Stryker disable once <mutator>:
<reason>` after developer sign-off (skill's disposition #5/#9) — is the right tool;
the finding here is just that this *class* is common enough in the two big
reflection-heavy files to expect several sign-offs there, not that a new mechanism is
needed.

## 3. Process recommendation — point `/validate` Step 4 at `--diff-only`

`validate/SKILL.md` Step 4 currently says "run `/mutation-test`" with no flags — the
default file-level-scoped run. That default is exactly what produced the 114-item
backlog from an 8-file mechanical refactor, and will recur every time a future PR
touches `SchemaReflector.cs` or `PluginWriter.cs` (its ambient entropy has nothing to
do with that PR's actual diff). Given `--diff-only` now exists and is confirmed
accurate (§1a), the actual regression-detection signal (**did this diff introduce
anything**) should be the pass/fail gate, with the full file-level audit run
separately and *not* blocking merge — filed as backlog, triaged at its own pace, the
way `MUTATION-TRIAGE-HANDOFF.md` is being handled now.

**Needs developer decision:** update `validate/SKILL.md` Step 4 to run `--diff-only`
as the gate, and only suggest the full audit as a follow-up (not required for Step 5
merge) when it surfaces non-empty.

## Open items requiring developer sign-off

- [x] §1b: removed `--mutant-ids` from `run.sh` entirely; `SKILL.md`'s confirm-workflow
      guidance now points at `--file <File>.cs`, and `--file` itself was fixed to disable
      `since` (previously it left `since` enabled, so confirming a fix on a file with no
      diff vs `main` would silently produce zero mutants and no report — the same trap
      that made the original `--mutant-ids` confirmation attempt fail). Both `SKILL.md`
      and `run.sh`'s own header comment now document that `mutant-id` isn't a real
      Stryker.NET config key, so it doesn't get re-added later.
- [ ] §1d: still open — time a `--file`-scoped, since-disabled run to confirm/refute the
      slowness before fully trusting the "confirm fixes with targeted runs" workflow.
      `SKILL.md` now carries a caveat not to assume it's fast.
- [x] §2 Class A: added the "equivalent-under-invariant" fast path to `SKILL.md`'s
      gating-question section (not a suppression — a triage-speed heuristic).
- [ ] §2 Class B: no action needed beyond continuing to use per-instance source
      annotations as each is confirmed during triage.
- [x] §3: `/validate` Step 4 now runs `/mutation-test` with `--diff-only` as the merge
      gate; a full unflagged run is documented as a separate, non-blocking entropy audit.

Delete this file once the remaining open item (§1d) is actioned or explicitly declined.
