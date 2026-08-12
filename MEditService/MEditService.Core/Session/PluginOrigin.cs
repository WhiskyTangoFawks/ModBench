namespace MEditService.Core.Session;

// ADR-0036: plugin identity is (origin, filename), not filename alone. `origin` is the mod folder
// that provided the physical file, treated as an opaque string on this side of the boundary —
// Editing never interprets it; only Mod Management (modbench/src/modmanager/) knows it names a mod
// folder and is the only side that renders it. A mod-provided or MO2-overwrite origin is supplied
// by the caller (Mod Management is the only side that can tell those apart); this is the one
// reserved value the Editing context assigns on its own, for every plugin resolved directly from
// the game's Data folder — vanilla, DLC, Creation Club, or freshly created via AddPlugin/CreatePlugin.
public static class PluginOrigin
{
    /// <summary>Reserved origin for a plugin resolved from the game's Data directory. Matches the
    /// literal directory name per ADR-0036 — safe from colliding with a real MO2 mod folder name,
    /// since mod folders live under a different namespace (`mods/`), never `Data`.</summary>
    public const string DataDirectory = "Data";
}
