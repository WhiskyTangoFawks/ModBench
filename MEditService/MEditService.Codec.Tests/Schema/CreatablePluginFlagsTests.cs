using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Schema;

public sealed class CreatablePluginFlagsTests
{
    private static string[] Offered(GameRelease release, ModType type) =>
        [.. CreatablePluginFlags.Of(release, type).Select(combination => string.Join('+', combination))];

    [Fact]
    public void AnEsp_OnAGameWithLightPlugins_OffersEveryCombinationOfMasterAndSmall()
    {
        Assert.Equal(["", "Master", "Small", "Master+Small"], Offered(GameRelease.Fallout4, ModType.Plugin));
    }

    [Fact]
    public void AnEsm_KeepsMaster_AndOffersEachSmallerStyleBesideIt()
    {
        Assert.Equal(["Master", "Master+Small", "Master+Medium"], Offered(GameRelease.Starfield, ModType.Master));
    }

    [Fact]
    public void AnEsl_OffersOneCombination_SoThereIsNoPick()
    {
        Assert.Equal(["Master+Small"], Offered(GameRelease.Fallout4, ModType.Light));
    }

    [Fact]
    public void AnEsm_OnAGameWithNoLightPlugins_OffersOneCombination()
    {
        Assert.Equal(["Master"], Offered(GameRelease.Oblivion, ModType.Master));
    }

    [Fact]
    public void AnEsp_OnAGameWithNoLightPlugins_OffersNoFlagsOrMaster()
    {
        Assert.Equal(["", "Master"], Offered(GameRelease.Oblivion, ModType.Plugin));
    }
}
