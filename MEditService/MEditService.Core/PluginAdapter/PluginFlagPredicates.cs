using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Meta;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.PluginAdapter;

/// <summary>A plugin's flags and its FormID range. The header flag is authoritative and the
/// extension only a secondary path, as in Mutagen's own <c>IModFlagsGetter</c>.</summary>
public static class PluginFlagPredicates
{
    /// <summary>The floor a fresh FormID is drawn above: <c>GetDefaultInitialNextFormID</c> is this
    /// for every mod of a release.</summary>
    public static uint HighRangeFormIdFloor(GameRelease release) =>
        GameConstants.Get(release).DefaultHighRangeFormID;

    /// <summary>Mutagen's own <see cref="Mutagen.Bethesda.Plugins.FormID.SmallIdMask"/>, restated
    /// once here so every call site reads one name. The range's game-dependent <i>lower</i> bound is
    /// <c>RecordCompactionCompatibilityDetection.GetSmallMasterRange</c>'s to answer.</summary>
    public const uint LightLocalFormIdCap = Mutagen.Bethesda.Plugins.FormID.SmallIdMask;

    // Plain statics, not extension methods: an extension named IsMaster on IModFlagsGetter is never
    // considered, because member lookup finds that interface's own IsMaster property first.
    public static bool IsLight(IModFlagsGetter mod, string fileName) =>
        mod.IsSmallMaster || fileName.EndsWith(".esl", StringComparison.OrdinalIgnoreCase);

    public static bool IsMaster(IModFlagsGetter mod, string fileName) =>
        mod.IsMaster || fileName.EndsWith(".esm", StringComparison.OrdinalIgnoreCase);
}
