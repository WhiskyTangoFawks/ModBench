# Modbench-2.1 — Data foundation

**Status: Complete** · Parent: [modbench-2](modbench-2.md) · Depends on: Modbench-1 · **Model: Opus 4.8**

*Goal: Establish the data layer everything else rests on — `IModlistSource`, the MO2 adapter with byte-faithful round-trip, `GameDirectory`, and the native adapter. No UI. Prove serialization correctness before any tree is built on top of it.*

The MO2 round-trip (separators, categories, metadata verbatim) is the riskiest unknown in Modbench-2. Isolating it here lets the tree phases (2.2, 2.3) be built on a proven foundation.

---

> **Scope corrections (confirmed during planning):**
>
> - **No new game-path config / no autodetect.** The user opens the MO2 instance folder *as the VS Code workspace*; the workspace root **is** the instance directory and `ModOrganizer.ini` there carries `selected_profile`/`gamePath`. There is no autodetect for the instance folder, and 2.1 consumes no game directory. The existing `GamePathDetector` is untouched (serves editing/vanilla masters in later phases).
> - **Separator format** is `[+|-]<name>_separator` (real MO2/LitR), not `_separator_<name>|1`.
> - **Native adapter deferred** — see Deferred section below.
> - **Byte-faithfulness** is achieved by *surgical edits over the raw text* (splice the targeted bytes; never re-serialize from the model), so CRLF/comments/`*` unmanaged lines/order all survive untouched.

## Extension

- [x] `IModlistSource` over an in-memory model. Types in [model.ts](../../medit-vscode/src/modmanager/model.ts): `Mod { name, enabled, version?, nexusId?, archiveFilename? }`, `Separator { name, enabled }`, `ModlistEntry = Mod | Separator`. Ordered list = priority order (top = highest).
- [x] **MO2 adapter** ([Mo2ModlistSource.ts](../../medit-vscode/src/modmanager/mo2/Mo2ModlistSource.ts) + pure transforms in `mo2/`):
  - `mods/<name>/meta.ini` joined per mod — `[General] modid`→nexusId, `version`, `installationFile`→archiveFilename; `modid=0`/blank → `undefined`.
  - active profile's `modlist.txt` — `+`/`-` prefixes; `[+|-]<name>_separator` interleaved in priority order; comment/`*` lines preserved verbatim.
  - active profile's `plugins.txt` — read only.
  - `ModOrganizer.ini` — `[General] selected_profile` (`@ByteArray(...)`-aware) read + surgical write.
  - **Round-trip fidelity** proven: surgical edits leave every unmodelled byte identical; verified against the full real LitR `modlist.txt` via an opt-in test.
- [ ] **Native adapter** — **deferred** (creates a fresh empty MO2 instance; not exercised by the open-existing-folder workflow). See Deferred section.

---

## Tests

- [x] Unit: byte-faithful round-trip — surgical edits leave all other bytes identical; full real LitR `modlist.txt` toggled off/on reproduces original bytes (opt-in test).
- [x] Unit: enable/disable updates the `+`/`-` prefix and round-trips cleanly.
- [x] Unit: reorder produces the correct line order in `modlist.txt`.
- [x] Unit: profiles enumerated from `profiles/`; selecting a profile reads that profile's `modlist.txt`; `selected_profile` persisted to `ModOrganizer.ini`.
- [x] Unit: `meta.ini` fields (version, nexusId, archiveFilename) read correctly; absent/blank fields produce `undefined`, not errors.

---

## Open question — resolved

MO2 round-trip fidelity is proven against a **trimmed-real** fixture committed at `medit-vscode/src/modmanager/test/fixtures/mo2-instance/` (captured from LitR: comment header, enabled/disabled mods, `[+|-]…_separator`, `*` unmanaged lines, CRLF, varied `meta.ini`, 2 profiles). The full real LitR instance backs an opt-in test (`MEDIT_LITR_INSTANCE`, skipped when absent) rather than being committed.

## Deferred

- **Native adapter** (create a fresh empty MO2 instance from scratch). Not exercised by the open-existing-folder workflow; scope it when a "New instance" feature is actually wanted.

---

## Proof

```text
Test Files  23 passed (23)
      Tests  296 passed (296)
```

`npm run build` (tsc --noEmit + esbuild + webview) clean. Validated via `/simplify` + `/code-review` (high). Commit: `4cc6168`.
