namespace MEditService.Core.Plugins;

// ADR-0036: plugin identity is (origin, filename), not filename alone. `origin` is opaque on this
// side of the boundary: Editing never interprets it, and only Mod Management knows it names a mod
// folder and renders it.
public static class PluginOrigin
{
    /// <summary>The one origin Editing assigns on its own, for a plugin resolved from the game's
    /// Data directory (ADR-0036). It cannot collide with an MO2 mod folder name: those live under
    /// `mods/`, never `Data`.</summary>
    public const string DataDirectory = "Data";
}
