# FLST — FormID List

xEdit: wbDefinitionsFO4.pas:7648. mEdit: table `flst`, HasVmad=False.

## Discrepancies
No discrepancies found.

## Notes
- xEdit: `EDID`, `wbFULL` (Name), `wbRArrayS('FormIDs', wbFormID(LNAM, 'FormID'), ..., sorted)`. mEdit: `name` (string), `items` (array). Matches — confirmed via Mutagen's `FormList.xml` that `Name` (`FULL`) genuinely exists on this record (not obviously expected for a "FormID List" at first glance, but both xEdit and Mutagen agree it's there).
- `items` is an opaque JSON array of FormLinks (`List<FormLink<Fallout4MajorRecord>>` in Mutagen, unrestricted target type) — matches xEdit's unrestricted `wbFormID(LNAM, 'FormID')`. The sortedness (`wbFLSTLNAMIsSorted`) isn't independently visible from the schema dump but isn't a shape discrepancy — it's a runtime write-ordering concern, not a schema-shape one.
- FLST has no `OBND`/`DEST`/VMAD in xEdit's own definition, so it's unaffected by the gaps seen elsewhere in this batch. This is the cleanest record type in the batch.
