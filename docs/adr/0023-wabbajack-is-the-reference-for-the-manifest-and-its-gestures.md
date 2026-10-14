# Wabbajack is the reference for the manifest and its gestures

Wabbajack decides how a mod is recorded and rebuilt: what a manifest holds, that restoring is declarative, and the two gestures between a mod folder and its manifest, one in each direction. Git versions the manifests with its own gestures, and a Modbench gesture takes a git word only when it runs that git operation, because a git word on any other gesture promises behaviour it lacks (Existing tools). The rule governs the manifest and its gestures alone, and [wabbajack.md](../out-of-scope/wabbajack.md) records every divergence and omission: mod management follows MO2 ([ADR-0017](0017-mo2-is-the-reference-for-mod-management.md)) and record editing xEdit ([ADR-0018](0018-xedit-is-the-reference-for-record-editing.md)).

## Consequences

- Wabbajack's own words, compile and install, already name a plugin's build and MO2's install in Modbench, so its two gestures take other words, and the register records them.
- A git checkout, pull or merge changes manifests and leaves the mod folders as they were. The user restores the folders, as a developer restores packages after a pull.

## Alternatives rejected

- Git's words and status letters for the gestures. A menu item has no namespace, so a Modbench Discard Changes sits beside git's on a manifest's row, and the letters promise an index that does not exist: a checkout then needs a stale state and a mark to explain itself.
- Git hooks that update the manifests before a commit and restore the folders after a checkout, so git's gestures are the only gestures. A failed post-checkout hook does not fail the checkout, so folders are left half restored with nothing shown; a pre-commit hook commits manifests the user never reviewed; and both need mEdit running.
- The mod folders as a second provider in Source Control. It is a second set of git-shaped gestures for operations that are not git's.
- Wabbajack's compiler, shipped. Its licence permits it, but its stack serves distribution of one profile to strangers, and the register cuts most of it.
