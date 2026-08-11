# DOBJ — Default Object Manager

xEdit: wbDefinitionsFO4.pas:8698. mEdit: table `dobj`, HasVmad=False.

## Discrepancies
No discrepancies found.

## Notes
- xEdit: `EDID` + `wbArrayS(DNAM, 'Objects', wbStructSK([0], 'Object', [wbInteger('Use', ..., wbEnum([], c)), wbFormID('Object ID')]))` — an array of `{Use, Object}` pairs, where `Use` is drawn from a dynamically-built enum list `c` (of DFOB editor IDs / use-category names). mEdit: `objects` (opaque JSON array) — matches structurally at the top level (array of "Object" entries); the per-element `Use`/`Object ID` shape is not independently visible in the dump because *all* array columns in this schema collapse to opaque JSON regardless of element structure (confirmed by grepping the whole dump: zero array columns anywhere have non-empty `subFields`). This is deliberate per ADR-0005, not specific to DOBJ.
- Underlying Mutagen model: `DefaultObjectManager.Objects : RefList<DefaultObjectUse>`, where `DefaultObjectUse.Use` is typed as `RecordType` (a raw 4-byte signature tag), not a real .NET enum — this is a plausible reason xEdit needs a dynamically-built `wbEnum` list (`c`) rather than a static one. Doesn't surface as a separate discrepancy since it's inside the opaque JSON blob.
- Reviewed together with DFOB (see dfob.md) — no cross-type shape mismatch found; mEdit's split matches xEdit's own DFOB/DOBJ record-type split.
