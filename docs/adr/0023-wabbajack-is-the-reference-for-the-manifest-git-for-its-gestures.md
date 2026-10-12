# Wabbajack is the reference for the manifest, git for its gestures

Wabbajack decides how a mod is recorded and rebuilt: what a manifest holds, and that restoring is declarative, replacing every file whose bytes differ from the manifest and touching nothing else. Git decides what the user sees and does with the record, and what it is called, in the labels VS Code gives git: the index, the working tree, untracked and stale, `init`, `stage`, `checkout`, `discard changes` and `clean`. Every divergence and omission from either is recorded in [wabbajack.md](../out-of-scope/wabbajack.md). The rule governs the manifest and its gestures alone: mod management follows MO2 ([ADR-0017](0017-mo2-is-the-reference-for-mod-management.md)) and record editing xEdit ([ADR-0018](0018-xedit-is-the-reference-for-record-editing.md)).

## Alternatives rejected

- Wabbajack's compiler, shipped. Its licence permits it, but its stack serves distribution of one profile to strangers, and the register cuts most of it.
