# Modbench-2.1 — Data foundation

**Status: Not Started** · Parent: [modbench-2](modbench-2.md) · Depends on: Modbench-1 · **Model: Opus 4.8**

*Goal: Establish the data layer everything else rests on — `IModlistSource`, the MO2 adapter with byte-faithful round-trip, `GameDirectory`, and the native adapter. No UI. Prove serialization correctness before any tree is built on top of it.*

The MO2 round-trip (separators, categories, metadata verbatim) is the riskiest unknown in Modbench-2. Isolating it here lets the tree phases (2.2, 2.3) be built on a proven foundation.

---

## Extension

- [ ] `GameDirectory` — `medit.gameDirectory` VS Code config; `GamePathDetector` autodetect fallback (already exists — wire it). One-time stock-game-folder setup option (prompt user if neither config nor autodetect resolves).
- [ ] `IModlistSource` interface over an in-memory modlist model. Model types: `Mod { name, enabled, version?, nexusId?, archiveFilename? }`, `Separator { name, enabled }`, `ModlistEntry = Mod | Separator`. Ordered list = the full modlist in priority order (top = highest).
- [ ] **MO2 adapter** — reads a MO2 instance:
  - `mods/<name>/` — enumerate installed mods from subdirectories
  - active profile's `modlist.txt` — `+`/`-` prefix for enabled/disabled; separator lines (`_separator_<name>|1`) interleaved in priority order
  - active profile's `plugins.txt` — read only (ModListProvider does not manage plugin order; that is the Plugin List view)
  - per-mod `meta.ini` — `[General] modid`, `version`, `installationFile` (archive filename)
  - `ModOrganizer.ini` — `[General] selected_profile` for default active profile
  - **Round-trip fidelity**: preserve any unrecognised lines, separator metadata, and category markers verbatim on write. The adapter must be able to read its own output and produce identical bytes.
- [ ] **Native adapter** — writes a fresh MO2-format instance so it opens in MO2 too. Wraps the MO2 writer; no separate format.

---

## Tests

- [ ] Unit: MO2 adapter reads a fixture `modlist.txt` (with separators, categories, disabled mods, `meta.ini`) into the model and writes it back byte-for-byte identical.
- [ ] Unit: enable/disable a mod updates the `+`/`-` prefix and round-trips cleanly.
- [ ] Unit: reorder two mods produces the correct line order in `modlist.txt`.
- [ ] Unit: profiles enumerated from `profiles/`; selecting a profile reads that profile's `modlist.txt`; `selected_profile` persisted to `ModOrganizer.ini`.
- [ ] Unit: `meta.ini` fields (version, nexusId, archiveFilename) read correctly; absent fields produce `undefined`, not errors.

---

## Open question

MO2 round-trip fidelity needs a fixture from a real MO2 instance. Use the LitR instance from Modbench-1 validation — export a real `modlist.txt` as the fixture file.

---

## Proof

*To be filled in on completion. Paste `npm run test:unit` output and commit hash here.*
