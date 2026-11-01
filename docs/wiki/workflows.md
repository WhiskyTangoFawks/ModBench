# Workflows

Modbench keeps two kinds of git repositories. The modlist repository in the Mod Manager instance folder, and a mod repository, for each decompiled mod. The modlist repository holds the mod manifests, the profiles and Mod Manager Instance configuration. A source mod's repository, in `source/`, holds that mod's plugin source, its assets and its build file. Understanding how to use git effectively as part of a standard software development workflow is key to using Modbench.

## The 2 Step Process for Modlists Management in Git

Because a git repo can't hold gigabytes of files, Modbench is setup to commit a mod's manifest, which contains the list of installed files, the package they're installed from, and the host where the package can be retreived. This means we have a 2 step process for managing the modlist: 1- the git action, and 2- the modbench action to restore the mod from the manifest.

- Before you commit the modlist, run Update Manifests, so the manifests say what your mod folders hold. This is how you track new modlist changes in git.
- After a checkout, a pull or a merge of the modlist, run Restore from Manifests…, so your mod folders hold what the manifests say.
- After a source mod's source changes, run Build Mod, so its mod folder holds what its source makes, and its manifest records it. Update Manifests records a source mod's source folder, and Build Mod records its mod folder.

With no mod selected, Update Manifests and Restore from Manifests… act on every mod. Both are in the overflow menu of the Source Control view's title bar.

## The modlist repository

### Put a modlist in git

Run Git Init Modlist. It makes the instance folder a repository, with an ignore list that keeps the mods' files out of git. Run Update Manifests, then stage and commit in Source Control.

A manifest can record any folder inside the instance, not only a mod: the folder it sits in. The cleanest setup holds every game file as a mod, puts a manifest in the stock game folder that records only the game's executable, which works once every other game file is in a mod, because restore sends whatever else the folder holds to the trash, and records each MO2 plugin in a manifest in its folder, such as `plugins/rootbuilder` for Root Builder. Git then holds a manifest for every file the game runs. Modbench works with any setup.

Keep each mod folder to one installation file, as installing makes it, so where each folder comes from stays one fact. When a folder holds files from a second download or the game folder, Update Manifests finds it and names it as a second package, so the folder still restores. Then move the merged folder into a source mod, whose source folder holds the files and whose own manifest restores them.

GitIgnore is how the modlist knows which files to track, and what to ignore. It's setup with a default allow list, but can be managed by the user however they want. As the user, it is your responsibility to understand the limitations of git, and if you are going to publish this remotely, to only republish what you have permission to publish.

### Try a change on a branch

Create a branch, and change the modlist on it: install, upgrade, reorder or remove mods. Update the manifests and commit. To drop the change, switch back and restore.

A mod you installed on the branch has no manifest on the branch you return to. Restore leaves a mod folder with no manifest alone and names it in its report, so you uninstall it yourself.

### Roll back

Check out the commit that worked, or revert the commits that broke the game. Then restore. Restore asks once before it overwrites a change that no manifest holds.

### Work with other people

Push the modlist to a shared remote. Each mod's manifest is a file of its own, so when two people change different mods, their manifests merge cleanly. A conflict lands in one mod's manifest, or in a profile's mod order or plugin order, which are text files. After you pull or merge, restore.

Restore needs each installation file a manifest names in your downloads folder. When you are logged in to Nexus with a Premium account, restore downloads a missing file from the Nexus page its manifest names. It skips a mod whose file it cannot find or download, and names the file and why.

### Set up a modlist on another machine

Clone the modlist repository: the clone is the instance folder. Log in to Nexus, or put the installation files in its downloads folder. Then restore. The repository holds a token in place of each path to the instance folder, the game folder or the downloads folder, and restore puts this machine's paths there. Restore also clones each source mod that has a remote, and builds it.

## Source mods

Init Source Mod puts any mod under git. It makes a repository in `source/` that holds the mod's plugin source, its manifest, its build file, and only the files no package yields with their bytes, in one commit to `main` when you pick that, and uncommitted when you do not. The manifest names the packages the rest come from, and restore writes them into `source/`.

The build file is yours: Modbench writes the first one and never rewrites it. Build makes the mod folder exactly what the build file makes, and records it in a manifest in the mod folder, like any other mod's. When a build comes out differently on another machine, from a tool or the load order, the manifest changes and Source Control shows it.

The mod folder's name and the files you exclude belong to the modlist, not the source. Renaming the mod or excluding a file never touches the repository, and the next build keeps it.

### Publish a source mod

Give the source mod's repository a remote, and push it. The next Update Manifests makes it a submodule of the modlist repository, pinned at its commit, and Source Control shows the change to commit.

Push the source mod before the modlist. A modlist repository made by Git Init Modlist refuses a push that pins a commit the source mod's remote lacks, so the modlist never pins a commit a clone cannot fetch.

Restore never moves a source mod repository you have checked out at another commit. It skips that mod and names the commit.

A source mod's repository with no remote stays out of the modlist repository. Its mod row says its package has no host, so you see what a clone cannot rebuild.

## Workflows

There are two standard workflows, one for mods you create, and one for editing another author's plugin.

### Authored

For your own mods, you can use whatever workflow you want. Work directly on main, trunk based, whatever you want.

### Vendored

Another author's mod is theirs, so you never edit it in place. Keep it installed as an ordinary mod, and make a source mod of your own whose plugin overrides theirs.

Prefer a standard patch: a plugin of your own that holds only your edits, which needs no vendored workflow. When you need the whole plugin, the vendored workflow keeps your edits apart from each release:

1. Create an empty mod for your patch. Copy the author's plugin into it in the Explorer, then run Init Source Mod and commit. `main` now holds their plugin as it shipped.
2. Make a branch, and edit on it. Run Build Mod. Your plugin has the author's file name, so it wins the file conflict and overrides theirs.
3. When the author releases an update, upgrade their mod as you would any other. Switch to `main`, copy the new plugin into your mod's folder, decompile it, and commit. Then merge `main` into your branch, where each conflict lands in one record's file, and build.

Merge rather than rebase. The modlist pins your source mod's commits, so a rebase rewrites commits that older modlist commits point at, and a force-push leaves them unfetchable.

A whole-plugin patch redistributes part of the author's work. It still needs the author's mod and its assets to do anything, so it is justifiable, if not ideal, and a standard patch is preferred. Publishing it is your call: understand the mod's permissions before you push its repository. Publishing plugin source or assets you have no permission for is a violation of Nexus terms of service.
