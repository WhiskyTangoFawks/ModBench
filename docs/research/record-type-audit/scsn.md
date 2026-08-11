# SCSN — Audio Category Snapshot

xEdit: wbDefinitionsFO4.pas:12717. mEdit: table `scsn`, HasVmad=False.

No discrepancies found.

## Notes
`PNAM`→`priority` matches. `CNAM`-keyed rArray of `{Category [SNCT], Multiplier}` structs maps to `multipliers` (JSON array per ADR-0005) — the mEdit column name matches Mutagen's own `Multipliers` property (xEdit's field is unnamed/uses the array label "Category Multipliers"; Mutagen's shorter name isn't a mismatch, just a different label source).
