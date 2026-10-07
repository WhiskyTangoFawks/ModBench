namespace MEditService.LoadOrder;

// `origin` (ADR-0012) is opaque on this side of the boundary: Editing never interprets
// it, and only Mod Management knows it names a mod folder and renders it.
//
// A mod's origin is its folder name, so the two origins that are not mods end in `/`, which no
// folder name holds. Equal to Modbench's own constants: the snapshot carries them.
public static class PluginOrigin
{
    /// <summary>The origin of a plugin in the game's Data directory (ADR-0012).</summary>
    public const string DataDirectory = "Data/";

    /// <summary>The other origin that is not a mod (ADR-0012): the files outside every mod.</summary>
    public const string Overwrite = "overwrite/";
}
