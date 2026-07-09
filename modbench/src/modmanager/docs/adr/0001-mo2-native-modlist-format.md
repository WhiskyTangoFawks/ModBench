# medit's modlist format is MO2's format, behind a source adapter

medit does not invent its own modlist format. Its on-disk format **is** MO2's: a mod is a `mods/<name>/` folder, enable state and priority live in a profile's `modlist.txt` (`+`/`-` prefix, bottom = highest priority), load order in `plugins.txt`, and per-mod Nexus metadata in `meta.ini`. Persistence goes through an `IModlistSource` abstraction over an in-memory modlist model, with adapters: **MO2** (first-class, reads and writes an instance in place, preserving separators and metadata verbatim), **native** (writes MO2-format instances for fresh setups), and **Vortex** (deferred; read-first if feasible).

The driving requirement is "point mEdit at an MO2 folder and work on their modlist" — *work on*, not import. Sharing MO2's format means edits round-trip and a user can alternate between MO2 and mEdit on the same list, with zero conversion and no divergence. MO2 is first-class by construction rather than by a one-way importer.

## Consequences

- mEdit must round-trip MO2's format faithfully — unmodelled constructs (separators, categories, mod metadata) are preserved, not dropped.
- mEdit inherits MO2's instance conventions (`mods/`, `profiles/`, `downloads/`, `overwrite/`, `ModOrganizer.ini`). MO2 **profiles** therefore come nearly for free — the active session boundary is the active profile's modlist.
- No native `modlist.json` (as the original `docs/mod-manager.md` draft proposed); that draft is superseded here.
