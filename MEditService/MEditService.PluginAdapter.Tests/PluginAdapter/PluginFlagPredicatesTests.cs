using Mutagen.Bethesda;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginFlagPredicatesTests
{
    // TES5Edit's wbDefinitionsSF1.pas: {0x800} 'Blueprint' in Starfield's TES4 header flags.
    private const int BlueprintBit = 0x800;
    private const int MasterBit = 0x1;

    // MO2's pluginlist.cpp counts a blueprint flag only on a master-flagged plugin, or one named
    // .esm or .esl.
    [Theory]
    [InlineData(GameRelease.Starfield, BlueprintBit | MasterBit, "Ships.esp", true)]
    [InlineData(GameRelease.Starfield, BlueprintBit, "Ships.esm", true)]
    [InlineData(GameRelease.Starfield, BlueprintBit, "Ships.esl", true)]
    [InlineData(GameRelease.Starfield, BlueprintBit, "Ships.esp", false)]
    [InlineData(GameRelease.Starfield, MasterBit, "Ships.esm", false)]
    [InlineData(GameRelease.Fallout4, BlueprintBit | MasterBit, "Ships.esm", false)]
    [InlineData(GameRelease.SkyrimSE, BlueprintBit, "Ships.esm", false)]
    public void IsBlueprint_IsTheBlueprintBitOnAMaster_OnlyForAGameWithBlueprintPlugins(
        GameRelease release, int headerFlags, string fileName, bool expected) =>
        Assert.Equal(expected, PluginFlagPredicates.IsBlueprint(release, headerFlags, fileName));
}
