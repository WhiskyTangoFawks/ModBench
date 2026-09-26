using Mutagen.Bethesda;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginFlagPredicatesTests
{
    // TES5Edit's wbDefinitionsSF1.pas: {0x800} 'Blueprint' in Starfield's TES4 header flags.
    private const int BlueprintBit = 0x800;

    [Theory]
    [InlineData(GameRelease.Starfield, BlueprintBit | 0x1, true)]
    [InlineData(GameRelease.Starfield, 0x1, false)]
    [InlineData(GameRelease.Fallout4, BlueprintBit | 0x1, false)]
    [InlineData(GameRelease.SkyrimSE, BlueprintBit, false)]
    public void IsBlueprint_IsTheBlueprintBit_OnlyForAGameWithBlueprintPlugins(GameRelease release, int headerFlags, bool expected) =>
        Assert.Equal(expected, PluginFlagPredicates.IsBlueprint(release, headerFlags));
}
