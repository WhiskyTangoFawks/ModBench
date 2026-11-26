using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.PluginAdapter.Tests.RealData;

[Kind(Kinds.Tool)]
public sealed class ProofRealDataTests
{
    [Fact]
    public void TheCutDownPlugin_LosesNothingInTheProofText()
    {
        var divergence = TestAdapters.Mutagen().DivergenceFrom(
            RealDataPlugin.PluginFileName, RealDataPlugin.PluginPath, RealDataPlugin.PluginPath,
            EmptyLoadOrder.Of(GameRelease.Fallout4), PluginStrings.None).Answered();

        Assert.Null(divergence?.Description);
    }
}
