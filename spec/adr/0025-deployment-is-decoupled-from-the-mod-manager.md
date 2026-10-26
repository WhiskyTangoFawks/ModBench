# Deployment is decoupled from the mod manager

Modbench's deployment is decoupled from the mod manager. It is a module of its own that deploys the load order to a folder the user picks. The mod manager's own deployment is untouched.

## Consequences

- Deployment takes the load order as a value and never reads the mod manager's configuration. A profile's own INIs and saves are optional configuration the mod manager owns, so no deployment writes them.
- Modbench owns no launch. A VS Code task the user sets up starts the game, and runs deploy first when the user wants it to. A deployment type that shows its files only to a program it wraps ships the wrapper, and the user's task calls it.
- Deploy is a build. It makes the deployment folder hold the load order and writes only what differs, so nothing keeps a deployment current between two deploys.
- A file in the deployment folder that deploy did not write is the user's, because other programs write there. So deploy and purge never delete, overwrite or revert such a file, and they report it ([ADR-0003](0003-modbench-never-assumes-exclusive-ownership-of-a-file-used-by-another-program.md)).

## Alternatives rejected

- Deployment as the mod manager's, behind the Instance adapter. Each deployment then reproduces its mod manager's optional configuration, such as MO2's profile INIs and saves, and a user with no mod manager cannot play.
- Vortex as the reference for deployment. Vortex deploys into the game folder, backs up each file it replaces, and asks to keep or revert a change by another program. Modbench does none of these, so its register would list every behaviour and decide none.
- A deployment kept current as a state, reconciled live. It keeps state about a folder outside the instance current, and the user's task already deploys before a launch.
