# DFOB — Default Object

xEdit: wbDefinitionsFO4.pas:12371. mEdit: table `dfob`, HasVmad=False.

## Discrepancies
No discrepancies found.

## Notes
- xEdit: `EDID` + `wbFormID(DATA, 'Object')` (unrestricted FormID). mEdit: `object` (formKey, `formKeyTypes=[]`, `allowsNull=True`) — matches; Mutagen types `DefaultObject.Object` as `FormLink<Fallout4MajorRecord>` (unrestricted), consistent with xEdit's own unrestricted definition.
- Reviewed together with DOBJ (see dobj.md) per the paired manager/default-object pattern — both check out individually; xEdit itself models them as two separate record types (DFOB = one mapping, DOBJ = the singleton manager holding all mappings), and mEdit's two-table split matches that 1:1.
