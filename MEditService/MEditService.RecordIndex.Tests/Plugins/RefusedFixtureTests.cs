using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class RefusedFixtureTests
{
    [ForeignIndexHolderFact]
    public void AFixtureWhoseIndexSettlesRefused_FailsWithTheIndexsReasonBeforeItsPatienceRunsOut()
    {
        using var data = new PluginFixtureBuilder("refused-fixture").WithPlugin("A.esp").Build();
        Indexes.Reconciled(data, data.InstanceRoot).Dispose();
        using var otherWindow = ForeignIndexHolder.Hold(IndexFiles.In(data.InstanceRoot));

        var refused = Assert.Throws<InvalidOperationException>(() => Indexes.Reconciled(data, data.InstanceRoot, patience: TimeSpan.FromSeconds(30)));

        Assert.Contains("another Modbench window", refused.Message, StringComparison.Ordinal);
    }
}
