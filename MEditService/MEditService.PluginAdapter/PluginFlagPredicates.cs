using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Meta;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter;

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

    /// <summary>Mutagen's <c>MasterStyle.Medium</c>, read off the flags without
    /// <c>GetMasterStyle</c>, which throws on a header that is both light and medium. Such a plugin
    /// counts as light, the style Mutagen checks first.</summary>
    public static bool IsMedium(IModFlagsGetter mod, string fileName) =>
        mod.CanBeMediumMaster && mod.IsMediumMaster && !IsLight(mod, fileName);

    public static bool IsMaster(IModFlagsGetter mod, string fileName) =>
        mod.IsMaster || fileName.EndsWith(".esm", StringComparison.OrdinalIgnoreCase);

    // Mutagen's header flag enums name no blueprint bit; TES5Edit's wbDefinitionsSF1.pas names
    // 0x800 'Blueprint' in Starfield's TES4 header, and no other game gives the bit that meaning.
    private const int StarfieldBlueprintFlag = 0x800;

    public static bool HasBlueprintPlugins(GameRelease release) =>
        release.ToCategory() == GameCategory.Starfield;

    /// <summary>MO2's rule (pluginlist.cpp, ESPInfo): the blueprint bit counts only on a
    /// master-flagged plugin, or one named .esm or .esl.</summary>
    public static bool IsBlueprint(IModFlagsGetter mod, string fileName, int headerFlags) =>
        (headerFlags & StarfieldBlueprintFlag) != 0
        && (IsMaster(mod, fileName) || fileName.EndsWith(".esl", StringComparison.OrdinalIgnoreCase));
}
