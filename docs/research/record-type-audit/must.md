# MUST — Music Track

xEdit: wbDefinitionsFO4.pas:8873. mEdit: table `must`, HasVmad=False.

No discrepancies found.

## Notes
All fields map cleanly: `CNAM`→`type` (enum Palette/SingleTrack/SilentTrack), `FLTV`→`duration`, `DNAM`→`fade_out`, `ANAM`→`track_filename`, `BNAM`→`finale_filename`, `LNAM`→`loop_data` (struct: begins/ends/count), `FNAM`→`cue_points` (array), `SNAM`→`tracks` (array). `CITC` (`cpBenign` count) correctly absent. `wbConditions` is handled by the condition codec, not an ordinary column, per the audit's Conditions carve-out.
