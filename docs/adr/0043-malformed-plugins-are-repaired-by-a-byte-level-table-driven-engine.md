---
status: accepted
---

# Malformed plugins are repaired by a byte-level, table-driven engine; legitimate-but-unparseable plugins are refused, never repaired

The full contract is [docs/specs/medit-repair.md](../specs/medit-repair.md). Evidence base:
the 684-plugin LitR round-trip survey.

## Context

Track and Save & Compile parse through Mutagen, which is strict. The survey showed two
different reasons a real plugin fails it, and they need opposite answers:

- **Kind A — the data is legitimate; Mutagen's model is wrong.** `GenderedItem` equality,
  `Package.Data` ordering, a dead form-version gate in `MaterialSwap`, script struct-list
  links invisible to master derivation (Mutagen upstream issues 685–688). Vanilla plugins carry exactly
  these shapes.
- **Kind B — the plugin departs from what the Creation Kit writes.** Template subrecords out
  of order, a fixed-size `RDAT` two bytes short, a fixed-count `NAME` list one short, a
  counter disagreeing with its entries, a perk parameter block a function never takes. Every
  one was proven against *all* vanilla records of the type (e.g. 1,031/1,031 templates,
  138/138 `RDAT`, 110/110 `RACE`). xEdit tolerates them; Mutagen throws or silently drops.

Three ways to handle Kind B were on the table: ask Mutagen for lenient parsing; tell the user
to fix it in xEdit (a Pascal script, or just load-and-save, which re-serializes in definition
order); or repair the bytes ourselves before Mutagen ever sees them.

## Decision

1. **Kind A is never repaired.** A byte-level "fix" of correct data is data destruction.
   The diagnosis says *blocked upstream* and names the Mutagen issue; the plugin is refused
   until the pin carries the fix.
2. **Kind B is repaired by a Mutagen-free engine** that understands only the container
   format (record header, GRUP, subrecord, `XXXX`, zlib) and a **fixed operation set** —
   *reorder, pad, recount, insert-default, drop*. It never understands a record's meaning.
3. **Per-defect knowledge is a table, not code**: detector, operation, a vanilla-scan proof
   of the canonical form, and a real fixture. A row without all three does not ship. A defect
   needing a sixth operation is a design change, not a table addition.
4. **Repair is explicit and previewed.** Never run by Track, Compile or load. Lossless rows
   are pre-selected, lossy rows unselected with their byte cost, all confirmed in one modal.
   Detection (the diagnosis floor) runs at load and after failures; repair only on the
   gesture.

## Consequences

- We own a second, partial knowledge of the plugin format — deliberately shallow: the
  container grammar plus a table. It is game-generic by construction; the *rows* are per game
  and grow only through surveys with vanilla proof.
- The engine is testable without Mutagen and without game files beyond the fixtures; the
  vanilla proof scans stay as env-gated tests so they can be re-run when a game updates.
- Semantic conversions (e.g. legacy perk `EPFT 2` → `AVIF`) are out of reach on purpose;
  they are diagnosed and left to the user.
- Leniency is not requested upstream for Kind B. Upstream effort is spent on Kind A, where
  Mutagen is wrong.

## Alternatives rejected

- **Upstream leniency**: Mutagen's typed model has nowhere to put a 33rd `NAME` or a junk
  `EPF2`; order-tolerance might be accepted, shape-tolerance would not — and every upstream
  fix arrives bundled with an upgrade (0.54.0 broke us — Mutagen upstream issue 684). Doesn't serve the
  user who has the plugin today.
- **xEdit as the mechanism**: right by construction but breaks the flow — a Windows/Wine
  round-trip mid-Track, no automation, no CI, a second language to maintain. Kept as the
  escape hatch the diagnosis points at, and as the parity oracle for the table.
