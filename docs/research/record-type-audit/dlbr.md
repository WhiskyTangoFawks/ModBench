# DLBR — Dialog Branch

xEdit: wbDefinitionsFO4.pas:8856. mEdit: table `dlbr`, HasVmad=False.

## Discrepancies
No discrepancies found.

## Notes
`Quest` [QUST], `Category` (Player/Command enum), `Flags` (Top-Level/Blocking/
Exclusive bitmask), and `Starting Topic` [DIAL] all match xEdit's field list with
matching shapes and formKeyTypes. Quest is `SetRequired`/Starting Topic is
`SetRequired` in xEdit but mEdit shows `allowsNull=False` for quest and
`allowsNull=True` for starting_topic — xEdit's `.SetRequired` is a write-time UX
convenience (form validation), not evidence that the underlying field is
non-nullable in the binary format; Mutagen's own nullability for
`starting_topic` is the more authoritative signal here, so this isn't flagged as
a bug.
