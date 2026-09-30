namespace MEditService.LoadOrder;

// ADR-0012: plugin identity is (origin, filename), not filename alone. `origin` is opaque on this
// side of the boundary: Editing never interprets it, and only Mod Management knows it names a mod
// folder and renders it.
public static class PluginOrigin
{
    /// <summary>The one origin Editing assigns on its own, for a plugin resolved from the game's
    /// Data directory (ADR-0012). It cannot collide with an MO2 mod folder name: those live under
    /// `mods/`, never `Data`.</summary>
    public const string DataDirectory = "Data";

    /// <summary>The other reserved origin (ADR-0012 invariant 1): MO2's own `overwrite/`, not a
    /// mod's folder (invariant 2).</summary>
    public const string Overwrite = "overwrite";
}
