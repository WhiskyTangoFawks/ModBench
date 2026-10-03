namespace MEditService.LoadOrder;

// ADR-0012: plugin identity is (origin, filename), not filename alone. `origin` is opaque on this
// side of the boundary: Editing never interprets it, and only Mod Management knows it names a mod
// folder and renders it.
public static class PluginOrigin
{
    /// <summary>The origin of a plugin in the game's Data directory (ADR-0012). It cannot collide
    /// with an MO2 mod folder name: those live under `mods/`, never `Data`.</summary>
    public const string DataDirectory = "Data";

    /// <summary>The other reserved origin (ADR-0012): the files outside every mod,
    /// not a mod's folder itself.</summary>
    public const string Overwrite = "overwrite";

    /// <summary>Whether origin is the reserved value above, compared as the load order compares
    /// every origin.</summary>
    public static bool IsOverwrite(string origin) =>
        string.Equals(origin, Overwrite, StringComparison.OrdinalIgnoreCase);

    public static bool IsDataDirectory(string origin) =>
        string.Equals(origin, DataDirectory, StringComparison.OrdinalIgnoreCase);
}
