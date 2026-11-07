export const SOURCE_MODS_GUIDE = `A source mod works like a project repository and its build output. The mod folder is the output, and its source folder is the project.

- A source mod's folder is a build artifact. Its source folder, source/<name>, holds its plugin source, its assets and its build file.
- Change a source mod in its source folder, then call mod_build. A build makes the mod folder exactly what the build file makes, and records it in the mod folder's manifest. A change in the mod folder is lost at the next build.
- Modbench writes the first build file. After that, Modbench changes only the names that a rename carries. You and the user edit the rest.
- mod_version_in_git puts a mod in git. It makes the mod a source mod, whose source lives in one of three places:
  - Inlined in the instance repository. A push of the instance repository publishes it.
  - In a repository of its own, with a remote. It is published on its own, and the instance repository pins its commit.
  - In a repository of its own, with no remote. It stays on this machine and out of the instance repository, so a clone cannot rebuild it.
- Or mod_version_in_git puts the whole mod folder in the instance repository. The mod then stays an ordinary mod, not a source mod.
- Git holds the plugin source, the build file, and only the files that no package provides. The manifest names the packages that the other files come from.
- A source mod follows one of two git workflows:
  - Authored: the user is the author. main is the work, branched however the user likes.
  - Vendored: the user is not the author. main holds the author's plugin as each release ships it, decompiled, and the user's edits live on a branch. Commit each new release to main, and merge main into the branch.
- Merge, never rebase. The instance repository pins the source mod's commits, and a rebase leaves those pins on commits that a clone cannot fetch.
- To publish a source mod's own repository through git (not through a publisher such as Wabbajack):
  1. Push the source mod.
  2. Call mod_update_manifest. It writes the source mod's entry in .gitmodules, and lets source/<name> past the instance repository's ignore list.
  3. Pin its commit in the instance repository: git add source/<name>. Git warns "adding embedded git repository". The warning is expected.
  4. Push the instance repository.
- Until you pin the commit, list_problems says that the repository is not pinned.
- Publishing another author's work needs the author's permission. Never push it unless the user says that they have that permission.`;
