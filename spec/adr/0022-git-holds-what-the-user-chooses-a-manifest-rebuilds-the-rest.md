# Git holds what the user chooses; a manifest rebuilds the rest

Git holds what the user chooses, and a manifest records how the rest of each folder is made, so a clone rebuilds the instance. Modbench's defaults keep a mod author's work out of git: a package already pins it, and git should not republish it without the author's permission.

## Consequences

- Restore and build are imperative, although build may include declarative steps.
- A folder with no manifest is left alone, because it can be a mod the user has not recorded yet.
- A manifest names any number of packages, because one folder can take files from several downloaded files.
- A manifest records a change to how the game loads a mod's files, never to their content. A change to content makes the mod the maintainer's, and git holds it ([ADR-0027](0027-a-build-file-builds-a-source-mods-folder-from-its-source-folder.md)).
- A change to how the game loads a file acts on its package's copy. A change that makes a new file, such as packing or unpacking an archive, is a source mod's build step, even when no content changes. A manifest knows an archive only as a whole file.
- A source mod with a repository of its own is pinned as a git submodule, because git already pins one repository inside another ([principles](../principles.md): Existing tools).

## Alternatives rejected

- Committing every folder's files, with Git LFS for the binaries. The repository then holds gigabytes that the packages already pin.
- Wabbajack's one record for the whole list. While technically feasible with the manifest system, it's not designed to be used that way.
- One file for a source mod that its author writes and its build rewrites. Neither owns it.
- A source mod's record in its repository, as a lockfile. A patcher's output follows the load order, so the repository would change with every modlist that uses it.
- Git hooks that write the manifests before a commit and restore after a checkout. A failed post-checkout hook does not fail the checkout, and a pre-commit hook commits manifests the user never reviewed.
- A manifest that records packing and unpacking. A texture in an archive need not hold its loose file's bytes. Status would then need a second identity for a texture, and would read inside each archive it checks.
