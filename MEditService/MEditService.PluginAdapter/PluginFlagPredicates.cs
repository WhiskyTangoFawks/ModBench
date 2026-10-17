using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter;

/// <summary>A plugin's blueprint flag, which MO2's rule reads; the other flags are
/// <see cref="PluginFlags"/>'.</summary>
internal static class PluginFlagPredicates
{
    internal static bool HasBlueprintPlugins(GameRelease release) =>
        GameCodecs.For(release).BlueprintFlag != 0;

    /// <summary>MO2's rule (pluginlist.cpp, ESPInfo): the blueprint bit counts only on a
    /// master-flagged plugin, or one named .esm or .esl.</summary>
    internal static bool IsBlueprint(IModFlagsGetter mod, string fileName, int headerFlags, GameRelease release) =>
        (headerFlags & GameCodecs.For(release).BlueprintFlag) != 0
        && (PluginFlags.IsMaster(mod, fileName) || fileName.EndsWith(".esl", StringComparison.OrdinalIgnoreCase));
}
