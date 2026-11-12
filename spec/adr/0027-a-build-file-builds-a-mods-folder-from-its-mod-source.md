# A build file builds a mod's folder from its mod source

A mod source's build file says how its build makes the mod's folder from the mod source, and nothing else. The mod source's manifest restores what packages hold ([ADR-0022](0022-git-holds-what-the-user-chooses-a-manifest-rebuilds-the-rest.md)), so each file has one job and one owner: the author owns the build file, and Modbench owns every manifest.

## Consequences

- Build owns the mod folder, so a file in it that the mod source does not account for goes.

## Alternatives rejected

- A build file that names packages and the files it takes from them. It then restores as well as builds, and a mod source needs a second format to restore it.
