export const SETUP_GUIDE = `Setting up an instance works like setting up a project on a new machine. The toolchain is the user's to setup: the game, the mod manager, VS Code tasks and their tools. The instance repository is the project, and its manifests are the lockfiles. mod_restore_from_manifest is the install step that fetches and builds every dependency.

- Help the user install the toolchain as they choose.
- Modbench serves you once the workspace is an instance: a trusted folder that holds ModOrganizer.ini, mods/ and profiles/. A fresh clone qualifies before the mod manager's own files are in it.

A clone of a modlist:
1. Call list_profiles. It says whether Modbench found the game folder, and where it looked. When it did not, the game folder goes in the setting modbench.mods.gameFolder. Restore before that leaves the repository's path tokens in place of this machine's paths.
2. Ask the user to log in to Nexus with a Premium account, through the Toolbox's log in. No Modbench tool logs in, or tells you whether the user has. Without Premium, restore skips each mod whose installation file is missing, and names the file.
3. Call mod_restore_from_manifest with no argument. It puts this machine's paths in place of the path tokens, clones each source mod's repository at its pinned commit, takes each installation file from the downloads folder or Nexus, writes each mod's files and metadata, and builds each source mod. git submodule update is not needed.
4. Read each refused mod in its reply, and fix its cause, such as a file the user downloads by hand. Then call it again: a second restore costs only what is left.
5. Call list_mod_statuses and list_problems. A set-up instance has no mod that differs and no problem.

An instance with no repository:
1. Call modlist_git_init. It makes the instance folder a repository, or adopts the one it holds, with an ignore list that keeps the mods' files out. It writes no manifest and commits nothing.
2. Call mod_update_manifest with no argument. Then call list_problems, which names each file a clone could not rebuild.
3. Commit. The user reviews the change in Source Control.

To play, the user launches the game from the mod manager. Deploying without it needs a deployment folder that the user chooses.

If there is no AGENTS.md or CLAUDE.md present at the workspace root, suggest /init to the user to create it.
`;