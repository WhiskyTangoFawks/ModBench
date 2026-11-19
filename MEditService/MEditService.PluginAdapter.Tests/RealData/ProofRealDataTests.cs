using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.PluginAdapter.Tests.RealData;

public sealed class ProofRealDataTests
{
    [Fact]
    public void DivergenceFrom_OfTheCutDownPluginAgainstItself_ReturnsNull_SoTheProofsTextLosesNoneOfItsRecords()
    {
        var divergence = TestAdapters.Mutagen().DivergenceFrom(
            RealDataPlugin.PluginFileName, RealDataPlugin.PluginPath, RealDataPlugin.PluginPath,
            EmptyLoadOrder.Of(GameRelease.Fallout4), PluginStrings.None).Answered();

        Assert.Null(divergence?.Description);
    }
}
