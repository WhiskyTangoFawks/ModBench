namespace MEditService.LoadOrder;

// `origin` (ADR-0012) is opaque here: only Mod Management knows it names a mod folder.
//
// The two origins that are not mods end in `/`, which no folder name holds. Equal to Modbench's.
public static class PluginOrigin
{
    /// <summary>The origin of a plugin in the game's Data directory (ADR-0012).</summary>
    public const string DataDirectory = "Data/";

    /// <summary>The other origin that is not a mod (ADR-0012): the files outside every mod.</summary>
    public const string Overwrite = "overwrite/";
}
