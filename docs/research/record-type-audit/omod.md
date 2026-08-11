# OMOD — Object Modification

xEdit: wbDefinitionsFO4.pas:12568. mEdit: table `omod`, HasVmad=False.

## Discrepancies
No discrepancies found.

## Notes
- `DATA.Unknown Bool 1`/`Unknown Bool 2` (xEdit: two separate `itU8` booleans) collapse to a single `unknown` (`apiType=int`) column in mEdit. Traced to Mutagen: `AObjectModification.Unknown` is modeled as one opaque `UInt16`, not two booleans — same 2 bytes, different granularity of interpretation. (a) deliberate — inherited from Mutagen's own modeling, not a mEdit-introduced merge.
- `DATA.Form Type` (enum: Armor/Non-player character/Weapon/None) → `apiType=int` is absent from the sampled columns list as its own name, but this is because mEdit merges all 5 concrete OMOD subtypes (`ArmorModification`/`NpcModification`/`WeaponModification`/`ObjectModification`/`UnknownObjectModification`) into one `omod` table; `properties` (JSON array) carries the type-specific property list. Did not find a dedicated `form_type` column in the dump — worth a follow-up check by a human with direct DB access, since it wasn't fully traceable from static reflection alone within this audit's scope.
- `DATA.Items` (xEdit comment: "no way to change these in CK, legacy data leftover") and `DATA.Includes` both map to opaque JSON arrays (`items`, `includes`) — deliberate, consistent with the rest of the schema.
- `MNAM`/`FNAM`/`LNAM`/`NAM1`/`FLTR` map cleanly to `target_omod_keywords`/`filter_keywords`/`loose_mod`/`priority`/`filter`.
- `LNAM` (`Loose Mod`, `wbFormIDCk(LNAM, 'Loose Mod', sigBaseObjects)` — broad set of base-object types) → mEdit shows `formKeyTypes=[misc]` (narrowed to Misc. Item only). Traced to Mutagen: `AObjectModification.LooseMod` is typed as `FormLink<MiscItem>`, strongly narrower than xEdit's broad `sigBaseObjects`. (a) deliberate — inherited from Mutagen's stronger typing choice, not a mEdit bug; flagged here only because it's a real behavioral narrowing (mEdit's UI would refuse to link a loose mod to e.g. a Weapon, which xEdit's definition technically permits) — worth a human sanity-check against actual game data to confirm Misc. Item is in practice the only valid target.
- OMOD has no `OBND`/`DEST` in xEdit's own definition, so it's unaffected by the systemic gaps seen elsewhere in this batch.
