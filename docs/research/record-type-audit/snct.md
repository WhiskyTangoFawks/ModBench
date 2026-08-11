# SNCT — Sound Category

xEdit: wbDefinitionsFO4.pas:9547. mEdit: table `snct`, HasVmad=False.

No discrepancies found.

## Notes
All 8 xEdit fields (`FULL`→`name`, `FNAM` 7-bit flags, `PNAM`→`parent`, `ONAM`→`menu_slider`, `VNAM`→`static_volume_multiplier`, `UNAM`→`default_menu_volume`, `MNAM`→`min_frequency_multiplier`, `CNAM`→`sidechain_target_multiplier`) are present with matching shapes: the flags bitmask lists all 7 xEdit-named bits, and both `SNCT` formkey fields (`parent`, `menu_slider`) correctly scope to `[snct]`.
