# Git versions how each folder is made, not the folder

Git holds the description of a folder, as a manifest file for mods, and as a build file for source mods. Git cannot hold a modlist's gigabytes of files, nor should it republish a mod author's work without their permission.

## Consequences

- Restore and build are imperative, although build may include declarative steps.
- A folder with no manifest is left alone, because it can be a mod the user has not recorded yet.
- A source mod's repository is pinned as a git submodule, because git already pins one repository inside another ([principles](../principles.md): Existing tools).

## Alternatives rejected

- Committing the files, with Git LFS for the binaries. The repository then holds gigabytes that the packages already pin.
- Wabbajack's one record for the whole list. While technically feasible with the manifest system, it's not designed to be used that way.
- One file for a source mod that its author writes and its build rewrites. Neither owns it.
- A source mod's record in its repository, as a lockfile. A patcher's output follows the load order, so the repository would change with every modlist that uses it.
- Git hooks that write the manifests before a commit and restore after a checkout. A failed post-checkout hook does not fail the checkout, and a pre-commit hook commits manifests the user never reviewed.
