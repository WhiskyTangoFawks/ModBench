# MO2 is the reference for mod management

Modbench reconstructs Mod Organizer 2's workflow with VS Code's own UI conventions. Where MO2 has an
answer, Mod Management adopts it, and it goes further than a UX reference: MO2's files are
Modbench's files. Every divergence and omission is recorded in [mo2.md](../out-of-scope/mo2.md). The
rule does not govern record editing, which follows xEdit
([ADR-0018](0018-xedit-is-the-reference-for-record-editing.md)), or deployment, a boundary of its
own.

## Strategic invariants

1. **The on-disk format is MO2's, worked on in place, never imported.** A mod is a `mods/<name>/`
   folder. Enable state and mod order are a profile's `modlist.txt`, with a `+` or
   `-` prefix and the top of the file as the winning end. Each profile keeps its plugin order in
   its own `plugins.txt`, in the game's format; per-mod Nexus metadata is `meta.ini`, and the
   instance conventions are inherited whole. Point Modbench
   at an MO2 folder and it works on that modlist: edits round-trip, and a user alternates between
   MO2 and Modbench on one instance with no conversion and no divergence.
2. **Writes are byte-faithful surgical edits.** One read-modify-write of one MO2 file, with
   separators, comments and metadata preserved verbatim. Each MO2 file's format lives in one codec,
   inside the Instance adapter's MO2 implementation; `plugins.txt`'s format is the game's, and its
   codec is the kernel's ([ADR-0014](0014-modules-are-layered-and-call-adjacent-layers-through-ports.md)).
3. **MO2's panels map onto native VS Code surfaces.** Mods, Plugins and Downloads are native tree
   views stacked in the `modbench` container the way Explorer stacks its sections: independently
   collapsible, resizable, simultaneously visible, with native checkbox, drag-reorder and keyboard
   navigation for free. Mods and Plugins are touched constantly and get permanent slots. Plugins is
   the one Plugins tree: Mod Management's rows, and a running backend adds record browsing
   beneath them. There is no view mode and no mode for the backend's absence
   ([ADR-0002](0002-mod-management-and-editing-are-one-tool.md)).
4. **The auxiliary bar is never a default target for any Modbench view.** It is the conventional
   home for agentic chat, an assumed-present part of the UX this product is built around, so
   defaulting a view there would compete with chat for screen space. Views stay user-relocatable
   through VS Code's own Move View, so a user who wants MO2's literal side-by-side layout can
   build it. Modbench never assumes that choice, and nothing reserves or locks the bar.
5. **MO2 decides the behaviour, VS Code decides the interaction.** This is the principle *Mutagen's
   data, the reference's behaviour, VS Code's interaction* ([principles](../principles.md)), applied
   to Mod Management. Every departure from MO2's behaviour is a row on [the
   register](../out-of-scope/mo2.md). A divergence changes the behaviour. Its reason is a platform
   limitation, a principle ranked above this one, or a maintainer ruling. An omission leaves the
   behaviour out. Its reason is a row of the register's *Omissions by reason* table.

## Permitted divergences

[mo2.md](../out-of-scope/mo2.md) lists every divergence and every omission, with the reason for each.

## Alternatives rejected

- **A native `modlist.json` with an MO2 importer.** A one-way importer makes MO2 second-class by
  construction and lets the two lists diverge.
- **A Vortex adapter.** Deferred; read-first if a real need arrives.
- **Two containers by default, Downloads in the aux bar, for literal MO2 parity.** Claims the
  space reserved for chat.
- **A custom webview tab-switcher mimicking MO2's three-tab panel.** Reinvents widgets VS Code
  provides natively; the point is leaning on the platform, not rebuilding MO2's chrome.
- **Downloads as an editor-tab webview.** The richer per-item meta a tab's width could show turned
  out to be four columns behind a native context menu, nothing a tree cannot show.
- **Two Plugins trees, one per bounded context.** Kept the load order apart from the record browser
  to avoid conflating the contexts. Both objections are answered structurally: the tree works with
  no backend, and a plugin's identity, `(origin, filename)`
  ([ADR-0012](0012-every-plugin-in-the-instance-is-indexed.md), invariant 1), keeps the contexts
  apart.
