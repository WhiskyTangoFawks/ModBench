# xEdit's conflict model, read from the TES5Edit source

Findings from `xeMainForm.pas`, `wbInterface.pas` and `wbImplementation.pas` that inform
[ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md) invariant 5 and divergences 9 and 10.

## Two independent axes

- **ConflictThis**: this plugin's version of the record relative to the rest of the stack.
  Classifies each cell in the compare grid.
- **ConflictAll**: the summary classification for the whole override stack. Classifies each row.

A record may be `caConflict` overall while the master plugin's version is `ctMaster` and the
winning plugin's version is `ctConflictWins`.

`TConflictAll` (row level, background colour):

- `caUnknown`: not yet computed
- `caOnlyOne`: record exists in one plugin only
- `caNoConflict`: all overrides agree on all fields
- `caConflictBenign`: differences exist but all are marked low-priority
- `caOverride`: one plugin overrides and the change is uncontested
- `caConflict`: two or more plugins disagree; last wins
- `caConflictCritical`: injected records or fields marked critical are in conflict

`TConflictThis` (per-plugin cell, font colour or cell background):

- `ctUnknown` / `ctNotDefined`: structural absence or not computed
- `ctIgnored`: field has `cpIgnore` priority; excluded from conflict logic
- `ctOnlyOne`: single-plugin mode
- `ctMaster`: the originating plugin
- `ctIdenticalToMaster`: same values as the master; benign override
- `ctConflictBenign`: differs but priority-capped at benign
- `ctOverride`: uncontested override
- `ctConflictWins`: last plugin to change this field
- `ctConflictLoses`: overwritten by a later plugin

## ConflictPriority modifies the outcome

Every field definition carries a `ConflictPriority` the algorithm consults before classifying:

| Priority | Effect on detection |
|---|---|
| `cpIgnore` | Field excluded from conflict detection entirely |
| `cpBenign` | Differences capped at `caConflictBenign` / `ctConflictBenign` |
| `cpBenignIfAdded` | Benign if absent in the master (XLRL Location Reference) |
| `cpNormal` | Standard comparison |
| `cpNormalIgnoreEmpty` | Master absence is non-conflicting (DOBJ, actor templates) |
| `cpOverride` | Per-plugin result capped at `ctOverride` |
| `cpCritical` | Bumps to `caConflictCritical` if non-empty values differ |

Injected records, a FormKey from a master the plugin does not declare, are treated as
`cpCritical`. The priority system exists because xEdit works at the raw binary level and must
paper over redundant count fields, unused bytes and internal bookkeeping. Mutagen abstracts those
away, so the fields a priority table would annotate do not exist in Modbench's schema.

## Comparison uses resolved display values, not raw bytes

xEdit compares `DisplaySortKey` values, the human-readable resolved form. Two records with
different binary representations can be identical, for example a FormID that resolves to the same
target across different load-order slots.

## Partial forms are sparse by design

A record with the `IsPartialForm` header flag omits fields it does not override. Those absent
fields are treated as `cpIgnore`, not as empty values that differ from the master. Displaying them
as blank cells would read as the plugin setting those fields to null.

## Sorted versus unsorted arrays

`wbArrayS` arrays are matched by sort key before comparing elements, not by index. Where the key is
a member read off the element rather than the element's own value, a script's name, a property's
name, a fragment's index, that key aligns the columns, so a plugin carrying fewer elements reads as
an absence at those keys instead of shifting every row after it. For unsorted arrays, quest script
fragments for example, order is semantically significant and a positional mismatch is a real
conflict.

## Injected-record escalation

`ConflictLevelForNodeDatas` in `xeMainForm.pas` escalates an injected record to critical only when a
real value difference exists; a content-identical injected record stays non-conflicting.
