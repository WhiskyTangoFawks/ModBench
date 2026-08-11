# COBJ — Constructible Object

xEdit: wbDefinitionsFO4.pas:10348. mEdit: table `cobj`, HasVmad=False.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `Conditions` (`wbConditions`) | *(absent as an ordinary column)* | Not present in the reflected column dump. | Not a gap — per task instructions, Conditions are handled by the dedicated `ConditionCodecRegistry`/`Fallout4ConditionCodec` (which explicitly names COBJ's `Conditions` in its own comments), not exposed as an ordinary reflected column. Confirmed by reading `Fallout4ConditionCodec.cs`. |
| `INTV` (`Data`: single struct `{Created Object Count, Priority}`, occurs once) | `created_object_counts` (**array**, JSON) | xEdit models `INTV` as one struct occurring once per record; Mutagen models it as `RefList<ConstructibleCreatedObjectCount>` (a list), so mEdit exposes it as an array rather than a single nested struct. In practice each COBJ record has at most one `INTV`, so this is a shape widening (struct → array-of-≤1) rather than a data-loss issue. | (a) deliberate — inherited from Mutagen's own list-based modeling of `INTV`, not a choice mEdit made. |
| `CNAM` (`Created Object`, `wbFormIDCk(CNAM, ..., sigBaseObjects)`) | `created_object` (formKey, `formKeyTypes=[]` — unrestricted) | xEdit restricts to `sigBaseObjects` (a specific broad set of record types); mEdit shows no restriction at all. Traced to Mutagen: `CreatedObject` is typed via the `IConstructibleObjectTarget` marker interface rather than a concrete `refName`, so mEdit can't derive a concrete type list from it. | unclear, needs a human — plausibly deliberate (interface-typed link matching Mutagen's own broad-but-untyped modeling) but worth confirming `GetFormLinkValidTypes` couldn't do better for interface-typed FormLinks generally, since this pattern likely recurs elsewhere. |

## Notes
- `Components` (`FVPA`/`wbComponents` — array of `{Component FormID, Count}`) maps cleanly to `components`, an opaque JSON array — deliberate, consistent with every other array column in the schema (ADR-0005).
- `NAM1`/`NAM2`/`NAM3` (unused byte arrays, `wbNeverShow` in xEdit itself) are correctly absent from mEdit too — xEdit hides them as well, so this isn't a discrepancy.
- COBJ has no `OBND`/`DEST` in xEdit's own definition, so it's unaffected by the systemic ObjectBounds/Destructible gaps seen elsewhere in this batch (alch/book/cont/ingr/keym/misc).
- This is the crafting-recipe record specifically flagged for careful shape review; its component/output shape checks out structurally (both `Components` and `CreatedObjectCounts` collapse to JSON arrays as expected), modulo the two notes above.
