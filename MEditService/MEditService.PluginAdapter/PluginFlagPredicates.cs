using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter;

/// <summary>A Starfield plugin's blueprint flag, which MO2's rule reads; the other flags are
/// <see cref="PluginFlags"/>'.</summary>
internal static class PluginFlagPredicates
{
    // Mutagen's header flag enums name no blueprint bit; TES5Edit's wbDefinitionsSF1.pas names
    // 0x800 'Blueprint' in Starfield's TES4 header, and no other game gives the bit that meaning.
    private const int StarfieldBlueprintFlag = 0x800;

    internal static bool HasBlueprintPlugins(GameRelease release) =>
        release.ToCategory() == GameCategory.Starfield;

    /// <summary>MO2's rule (pluginlist.cpp, ESPInfo): the blueprint bit counts only on a
    /// master-flagged plugin, or one named .esm or .esl.</summary>
    internal static bool IsBlueprint(IModFlagsGetter mod, string fileName, int headerFlags) =>
        (headerFlags & StarfieldBlueprintFlag) != 0
        && (PluginFlags.IsMaster(mod, fileName) || fileName.EndsWith(".esl", StringComparison.OrdinalIgnoreCase));
}
