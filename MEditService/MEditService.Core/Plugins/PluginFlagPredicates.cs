using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Plugins;

/// <summary>The header flag is authoritative and the extension only a secondary path, as in
/// Mutagen's own <c>IModFlagsGetter</c>: the common light plugin is a header-flagged esp, and an
/// ESM-flagged esp is a legal master.</summary>
public static class PluginFlagPredicates
{
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
