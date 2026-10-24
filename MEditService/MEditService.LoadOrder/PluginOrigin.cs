namespace MEditService.LoadOrder;

// `origin` (ADR-0012) is opaque here: only Mod Management knows it names a mod folder.
//
// The Data directory's origin ends in `/`, which no folder name holds. Equal to Modbench's.
public static class PluginOrigin
{
    /// <summary>The origin of a plugin in the game's Data directory (ADR-0012).</summary>
    public const string DataDirectory = "Data/";
}
