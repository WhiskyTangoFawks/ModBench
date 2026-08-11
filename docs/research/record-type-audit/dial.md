# DIAL — Dialog Topic

xEdit: wbDefinitionsFO4.pas:6387. mEdit: table `dial`, HasVmad=False.

## Discrepancies
No discrepancies found.

## Notes
- xEdit's `Category`/`Subtype` (DATA struct members) and the top-level `Priority`,
  `Branch` [DLBR], `Quest` [QUST], `Keyword` [KYWD] all have matching mEdit columns
  with matching formKeyTypes restrictions.
- `topic_flags` (mEdit) ↔ xEdit's DATA.`Topic Flags` (Do All Before Repeating +
  2 unknown bits) — mEdit's enum only names the one documented bit
  (`DoAllBeforeRepeating`); the two "Unknown" bits xEdit lists have no named
  member in Mutagen's flag enum, same shape as other partially-named bitmasks
  seen elsewhere in this batch (inherited from Mutagen, not a dial-specific
  issue — see term.md for the more consequential instance of this pattern).
- `subtype` correctly renders as a full enum (Custom0/ForceGreet/Rumors/.../Attack
  — mEdit's dump only prints the first 8 values in the trimmed field, but this is a
  dump-formatting artifact, not evidence of missing enum members).
- `responses` is a JSON-blob array (2+ level nesting — INFO records under a DIAL
  are indexed as their own top-level `info` rows; xEdit shows them as tree
  children of DIAL) — expected per ADR-0005, not a discrepancy.
