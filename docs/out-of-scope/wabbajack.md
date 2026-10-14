# Wabbajack: divergences and omissions

Where Wabbajack has an answer, the manifest and its gestures adopt it ([ADR-0023](../adr/0023-wabbajack-is-the-reference-for-the-manifest-and-its-gestures.md)). This file lists every place they do not.

What Wabbajack does: its source, a grep-only clone at `references/wabbajack/`.

## Omissions by reason

| Reason | Why | Gestures | Examples |
|---|---|---|---|
| VS Code provides it | Git and Source Control hold a modlist's history, versions and publishing, and the repository's README is its description ([principles](../principles.md), Existing tools). | 3 | Publish a list to the gallery; List metadata: name, author, image, readme, website, version; Validate a published list |
| Scripts, tasks or the agent | The operation runs an external tool or a one-off repair. | 3 | Force-heal a changed download with a back-port patch; Mirror a file; Recompress textures |
| Platform | Wabbajack fetches from sources Downloads does not have, and sets up a mod manager for a user who has none. | 2 | Download sources beyond Nexus and a URL; Force MO2 portable and write its configuration |
| Maintainer ruling | The gesture serves distribution of one profile to strangers, or a build step the user does with a tool. The gesture name says why. | 5 | Build a BSA from its files (a built BSA is a file); Merge zEdit patches; Include, ignore and no-match tag lists (the ignore list and the manifest do the job); Always-enabled mods (every mod is recorded); Remap paths in configuration files (a developer edits a config) |

## Divergences

What the manifest and its gestures do differently.

| # | Where | Modbench | Wabbajack | Why |
|---|---|---|---|---|
| 1 | What is recorded | Every mod and every profile, enabled or not | The enabled mods of the chosen profiles | Ruling: the repository is the user's instance, not a release. |
| 2 | The record's shape | One manifest per mod, in the mod folder | One JSON file for the whole list | ADR-0022. |
| 3 | Where a file comes from | The mod's installation files and the game folder | Any archive the user ever downloaded, by hash, nested archives included | Ruling: the mod manager's provenance is the truth, and a reader can see why a file has no provider. |
| 4 | A file nothing yields | The manifest says it has no provider, and restore from manifest skips the mod | Compile fails unless the path is tagged | Ruling: the gap is in the diff, and the rest of the modlist commits. |
| 5 | A file changed from its downloaded file's copy | No provider; deltas are deferred ([modlist-source.md](../architecture/surfaces/modlist-source.md), Deferred) | A delta, inlined in the `.wabbajack` file | ADR-0022: modding practice ships a change as a patch. |
| 6 | A missing installation file when the manifest is written | The mod is refused, naming the file | The archive is dropped and compile continues | Ruling: Never silently wrong. |
| 7 | A missing downloaded file at restore | Restore from manifest lands every mod whose downloaded files are present, and names each mod it could not with the file it lacks. Fetching is the user's. | Install stops when any archive cannot be fetched | Ruling: a mod gone from Nexus never blocks the rest, and restore downloads nothing. |
| 8 | Files the manifests do not name | Sent to the trash by restore from manifest, inside a mod folder that has a manifest; a mod folder with none is left for uninstall | Deleted from the install folder by its deletion rules | ADR-0003: the trash; ADR-0022: a folder with no manifest can be a mod not recorded yet. |
| 9 | Configuration paths | Committed with the paths they hold, and a clone edits them | Rewritten to placeholders and back | Ruling: a developer edits a config. |
| 10 | Words | update manifest, restore from manifest | compile, install | ADR-0023: compile names a plugin's build, and install names MO2's install. |
| 11 | A source mod with a remote | Restored by building its source at a commit, cloned when absent | No such source; every file comes from an archive or the list | ADR-0022. |
