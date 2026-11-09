export const INSTANCE_REPOSITORY_GUIDE = `The instance repository works like a repository of lockfiles. Git holds each mod's manifest, and Modbench restores the gigabytes of mod files from the packages that the manifests name.

- The instance folder is the instance repository. It holds each mod's manifest, the profiles and the instance's configuration, not the mods' files. Its .gitignore keeps the mods' files out, and the user changes it as they like.
- A manifest is a folder's lockfile. It names the packages that the folder is made from, each package's host, and each file.
- A manifest sits only in a mod's folder or a source mod's source folder. The mod manager's own files and the game folder are the user's to set up, and never get a manifest.
- Each change to the modlist takes two steps: a git action and a Modbench action.
  - Before a commit, call mod_update_manifest, so the manifests say what the mod folders hold.
  - After a checkout, a pull or a merge, call mod_restore_from_manifest, so the mod folders hold what the manifests say.
- After a source mod's source changes, call mod_build. The source-mods guide says more.
- git status does not show a mod whose files differ from its manifest, or a mod with no manifest. list_mod_statuses shows both. list_problems lists each state in which a clone would not rebuild the instance.
- To flag a plugin, such as ESL, set its flags in its mod's manifest and call mod_restore_from_manifest. Restore refuses a flag whose FormID range the plugin's records exceed.
- Keep each mod folder to one installation file. mod_update_manifest names each second package that it finds in a folder. To fix it, move the merged files into a source mod.
- A mod that you install on a branch has no manifest after you switch back. mod_restore_from_manifest leaves its folder alone and names it. Removing it is the user's call.
- mod_restore_from_manifest needs each installation file that a manifest names. When the user is logged in to Nexus with a Premium account, it downloads each missing file. Otherwise it skips the mod and says why.
- A merge conflict lands in one mod's manifest, or in a profile's mod order or plugin order. Each is a text file.
- The repository holds a token in place of each path to the instance folder, the game folder and the downloads folder. A clone on another machine restores with that machine's paths.
- Publishing the modlist is the user's call, and so is what they have permission to republish.`;
