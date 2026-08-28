---
status: accepted
---

# Mutagen used as a direct C# library for plugin parsing

Mutagen is used as a NuGet library, not shelled out via CLI. It provides strongly-typed C# objects
for every record type in every supported Bethesda game, and handles binary I/O, FormID↔FormKey
resolution, master list management, and record schema validation. Using it directly gives full
programmatic access to all record types.

## Alternatives rejected

- **Spriggit CLI** — a CLI wrapper around Mutagen for text serialization. Adds a process boundary
  and constrains the interface to what Spriggit exposes (see also ADR-0042).
- **xedit-lib** — the Delphi/Pascal library underlying xEdit. Requires native interop, is not
  idiomatic in any modern language, and has a narrow maintainer surface.
- **Custom binary parser** — no justification when Mutagen exists, is actively maintained, and
  covers all target games.
