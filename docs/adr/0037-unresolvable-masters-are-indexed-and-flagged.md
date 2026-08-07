---
status: accepted
---

# A plugin with unresolvable masters is indexed and flagged, never deactivated

A permitted divergence from [ADR-0034](0034-xedit-is-the-ux-reference-for-the-record-editor.md),
recorded here rather than assumed.

## Context

A common authoring pattern produces plugins whose masters are not present: to drop an unwanted
dependency, an author ships their own copy of a plugin with that master removed and lets it override
the original by mod priority. The original — now shadowed — declares a master that the load order
does not contain. [ADR-0035](0035-one-plugins-tree-editing-is-a-capability.md) makes such files
loadable on demand, so the question is no longer hypothetical.

xEdit's answer is unambiguous (`Core/wbLoadOrder.pas`): a module with an unresolvable master gets
`mfMastersMissing`; the flag propagates transitively through a fixpoint loop to anything that masters
it; flagged modules are then force-deactivated (`Exclude(miFlags, mfActive)`) and will not load. They
remain listed, carrying a `<MissingMasters>` descriptor in the text the user reads.

ADR-0034 requires adopting xEdit's answer unless a genuine platform limitation forces otherwise.

## Decision

**Load the plugin, flag the missing master, and do not deactivate.** This applies to every
population — eagerly-loaded and lazily-loaded alike — and including the case where the plugin is
enabled in `plugins.txt` and would therefore genuinely crash the game.

**The divergence is justified by architectural asymmetry, not preference.** Mutagen builds FormKeys
from a plugin's own `MasterReferences`, read from its TES4 header, so `ModFactory.ImportGetter` is a
per-file read that never requires a master file to exist. A FormID pointing at an absent master still
yields a well-formed FormKey; it simply names a ModKey nothing in the session provides, which already
resolves to nothing and already falls back to displaying the raw FormKey. xEdit's rule exists because
a Delphi object graph cannot resolve at all with a master missing. That is the inverse of the
carve-out ADR-0034 permits: not a platform limitation of ours, but a platform capability xEdit never
had.

**No cascade.** xEdit's transitive fixpoint exists solely because deactivation cascades. If a broken
plugin still loads, its dependents resolve against it normally and there is nothing to propagate.

**An enabled-but-broken plugin keeps its checkbox checked** and competes for winner as `plugins.txt`
says it does, with the failure surfaced loudly. The tree reports the user's actual configuration; it
does not silently disappear a plugin they believe is loading. The conflict picture then describes a
load order that would crash — which is the truth about that configuration, and the thing they need to
see in order to fix it.

**The flag distinguishes direct from inherited causes** in its tooltip ("Missing master: `X.esm`"
versus "Master `Foo.esp` cannot be loaded"), so a cascade does not read as many unrelated failures.

## Consequences

- **This is close to the existing behaviour.** Nothing currently checks masters at all —
  `BuildPluginMetadata` records `mod.MasterReferences` but never requires them — so the work is
  detection and display, a set difference against the loaded set, not a change to loading.
- **`PluginLoadFailure` gets surfaced.** `GameSession` already isolates per-plugin load failures with
  a reason so one unparseable file cannot abort the load order; that state has never reached the
  tree. It becomes the error decoration, alongside the missing-master flag.
- **The Plugin List's order-aware missing-master badge and this state become one concept** in one
  tree, instead of two views disagreeing about the same plugin.
- **What it buys, which xEdit cannot:** the shadowed original in the patch-out-a-master workflow can
  be opened and diffed against the patched copy, with the removed master's references showing as
  unresolved — which is exactly the check that workflow needs.
- **What it costs:** a plugin the game cannot load is browsable, so the tree must be unambiguous
  about which rows those are. That obligation is discharged by ADR-0035's dimming and error
  decoration, and this ADR is invalid without them.
