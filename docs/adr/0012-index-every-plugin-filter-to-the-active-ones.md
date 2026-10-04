# Index every plugin, filter to the active ones

The record index holds every plugin file in the instance, active or not. Every record view filters to the active plugins. A load order change then changes a filter and reads no file, so the editor follows it as it happens ([ADR-0002](0002-mod-management-and-editing-are-one-tool.md)).

## Consequences

- A filename no longer names a plugin. Two mods can ship the same filename, and the index holds both. A plugin is `(origin, filename)`: the file and the folder that provides it.

## Alternatives rejected

- Keep the index in step with the active plugins. Each load order change becomes a file read or a dropped row. A plugin that is not active then needs a second reading path.
- Bare filename as identity. It holds only while one file answers to each name.
- Absolute path as identity. It changes when the instance moves. It leaks the user's filesystem into every wire message.
