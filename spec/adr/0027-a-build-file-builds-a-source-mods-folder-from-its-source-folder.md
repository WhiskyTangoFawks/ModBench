# A build file builds a source mod's folder from its source folder

A source mod's build file says how its build makes the mod's folder from the source folder, and nothing else. The source folder's manifest restores what packages hold ([ADR-0022](0022-git-versions-how-each-folder-is-made-not-the-folder.md)), so each file has one job and one owner: the author owns the build file, and Modbench owns every manifest.

## Consequences

- Build owns the mod folder, so a file in it that the source mod does not account for goes.

## Alternatives rejected

- A build file that names packages and the files it takes from them. It then restores as well as builds, and a source folder needs a second format to restore it.
