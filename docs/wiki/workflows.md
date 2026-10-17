# Workflows

Modbench keeps two kinds of git repository. The modlist repository is the instance folder: it holds each mod's manifest, the profiles and MO2's configuration. A source mod's repository, in `source/`, holds that mod's plugin source and its other files. Each workflow below is ordinary git on one of them. This page says where Modbench's gestures fit in, and [git's own documentation](https://git-scm.com/doc) teaches git.

## The rule

Git moves manifests and source. Modbench moves mods.

- Before you commit the modlist, run Update Mod Manifest, so the manifests say what your mod folders hold.
- After a checkout, a pull or a merge of the modlist, run Restore Mod from Manifest…, so your mod folders hold what the manifests say.
- After a source mod's source changes, run Build Mod, so its mod folder holds what its source says.

With no mod selected, Update Mod Manifest and Restore Mod from Manifest… act on every mod. Both are in the overflow menu of the Source Control view's title bar.

## The modlist repository

### Put a modlist in git

Run Git Init Modlist. It makes the instance folder a repository, with an ignore list that keeps the mods' files out of git. Run Update Mod Manifest, then stage and commit in Source Control.

### Try a change on a branch

Create a branch, and change the modlist on it: install, upgrade, reorder or remove mods. Update the manifests and commit. To drop the change, switch back and restore.

A mod you installed on the branch has no manifest on the branch you return to. Restore leaves a mod folder with no manifest alone and names it in its report, so you uninstall it yourself.

### Roll back

Check out the commit that worked, or revert the commits that broke the game. Then restore. Restore asks once before it overwrites a change that no manifest holds.

### Work with other people

Push the modlist to a shared remote. Each mod's manifest is a file of its own, so when two people change different mods, their manifests merge cleanly. A conflict lands in one mod's manifest, or in a profile's mod order or plugin order, which are text files. After you pull or merge, restore.

Restore needs each installation file a manifest names in your downloads folder. It skips a mod whose file is missing, and names the file.

### Set up a modlist on another machine

Clone the modlist repository: the clone is the instance folder. Put the installation files in its downloads folder. MO2's configuration holds the first machine's paths, so edit them for this one. Then restore. Restore clones each source mod that has a remote, and builds it.

## Source mods

Decompile and Commit Mod puts a mod under git. It makes a repository in `source/` that holds the mod's plugin source, every other file of the mod, and a build configuration, in one commit. You choose how the repository uses its `main` branch.

### Author your own mod

In the authored workflow, `main` is your work. Edit records in the record panel or in the plugin source, review and commit in Source Control, then run Build Mod. The build writes the mod's folder and its manifest.

### Patch another author's mod

In the vendored workflow, `main` holds the author's releases, and your edits live on the `edit` branch. Decompile and Commit Mod puts the release you have on `main`. Create `edit` from it, and make your changes there.

When the author releases a new version:

1. In the source mod's repository, check out `main`.
2. Install the new release over the mod, so its files replace the old ones in the mod's folder.
3. Run Decompile Plugin on each of its plugins.
4. Copy the release's other files into the repository's `assets/` folder, and delete what the release dropped.
5. Commit, check out `edit`, merge `main`, and run Build Mod.

Each conflict lands in one record's file, except the plugin header's Next Object ID, which both branches move when they add records.

### Publish a source mod

Give the source mod's repository a remote, and push it. The next Update Mod Manifest makes it a submodule of the modlist repository, pinned at its commit, and Source Control shows the change to commit.

Push the source mod before the modlist. A modlist repository made by Git Init Modlist refuses a push that pins a commit the source mod's remote lacks, so the modlist never pins a commit a clone cannot fetch.

Restore never moves a source mod repository you have checked out at another commit. It skips that mod and names the commit.

A source mod's repository with no remote stays out of the modlist repository. Its mod row says its package has no host, so you see what a clone cannot rebuild.
