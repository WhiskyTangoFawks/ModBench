using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Analysis;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Codec.Serialization;

/// <summary>A plugin's flags. The header flag is authoritative and the extension only a secondary
/// path, as in Mutagen's own <c>IModFlagsGetter</c>.</summary>
public static class PluginFlags
{
    // Plain statics, not extension methods: an extension named IsMaster on IModFlagsGetter is never
    // considered, because member lookup finds that interface's own IsMaster property first.
    public static bool IsLight(IModFlagsGetter mod, string fileName) => mod.IsSmallMaster || IsEsl(fileName);

    /// <summary>Mutagen's <c>MasterStyle.Medium</c>, read off the flags without
    /// <c>GetMasterStyle</c>, which throws on a header that is both light and medium. Such a plugin
    /// counts as light, the style Mutagen checks first.</summary>
    public static bool IsMedium(IModFlagsGetter mod, string fileName) =>
        mod.CanBeMediumMaster && mod.IsMediumMaster && !IsLight(mod, fileName);

    public static bool IsMaster(IModFlagsGetter mod, string fileName) =>
        mod.IsMaster || fileName.EndsWith(".esm", StringComparison.OrdinalIgnoreCase);

    /// <summary>The local FormIDs <paramref name="mod"/>'s light or medium flag, or its <c>.esl</c> name,
    /// limits its native records to, or null for a plugin none limits.</summary>
    public static FormIdLimit? LimitOf(IModGetter mod, string fileName)
    {
        if (IsLight(mod, fileName))
            return Limit("light", RecordCompactionCompatibilityDetection.GetSmallMasterRange(mod), mod.IsSmallMaster, IsEsl(fileName));
        return IsMedium(mod, fileName)
            ? Limit("medium", RecordCompactionCompatibilityDetection.GetMediumMasterRange(mod), byFlag: true, byExtension: false)
            : null;
    }

    private static bool IsEsl(string fileName) => fileName.EndsWith(".esl", StringComparison.OrdinalIgnoreCase);

    private static FormIdLimit? Limit(string flag, RangeUInt32? range, bool byFlag, bool byExtension) =>
        range is { } limited ? new FormIdLimit(flag, limited.Min, limited.Max, byFlag, byExtension) : null;
}

/// <summary>The local FormID range a plugin's header flag limits it to (plugins.md, Compile story 4), the
/// flag's name, and what sets it: the flag, the <c>.esl</c> extension, or both.</summary>
public sealed record FormIdLimit(string Flag, uint Min, uint Max, bool ByFlag, bool ByExtension)
{
    /// <summary>The keys native to <paramref name="plugin"/> whose local FormID lies outside the range.</summary>
    public IReadOnlyList<FormKey> Outside(ModKey plugin, IEnumerable<FormKey> keys) =>
        [.. keys.Where(key => key.ModKey == plugin && (key.ID < Min || key.ID > Max))];
}
