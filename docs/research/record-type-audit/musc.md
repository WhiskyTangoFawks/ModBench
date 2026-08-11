# MUSC — Music Type

xEdit: wbDefinitionsFO4.pas:8743. mEdit: table `musc`, HasVmad=False.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `FNAM` Flags bit `0x10` "Removal Queued" | `flags` enum=`[PlaysOneSelection,AbruptTransition,CycleTracks,MaintainTrackOrder,DucksCurrentTrack,DoesNotQueue]` (6 of xEdit's 7 named bits) | Not dropped by mEdit's reflector — Mutagen's own `MusicType.Flag` `[Flags]` enum (`references/Mutagen/.../MusicType.cs`) omits the `0x10` member entirely; mEdit mirrors whatever Mutagen exposes. | (a) deliberate — upstream Mutagen gap, outside mEdit's reflection layer |

## Notes
Every other field matches: `PNAM` Data struct (`priority`, `ducking_decibel`), `WNAM` Fade Duration, `TNAM` Music Tracks (→ `tracks`, JSON array per ADR-0005). No mEdit-side bug identified for this type.
