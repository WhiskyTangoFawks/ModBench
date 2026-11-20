using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.TestSupport;

public sealed class CheckWaitTests
{
    [Fact]
    public void ACheckThatFailedAPlugin_FailsTheWaitOnIt_NamingTheFailure()
    {
        using var fixture = new PluginFixtureBuilder("check-wait")
            .WithPlugin("Checked.esp", mod => mod.Npcs.AddNew("CheckedNpc"), origin: "CheckedMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        File.WriteAllText(fixture.Plugins.Single().Path, "not a plugin");

        var thrown = Record.Exception(index.NextCheck);

        Assert.NotNull(thrown);
        Assert.Contains(Assert.Single(index.Status.Failures).Reason, thrown.Message, StringComparison.Ordinal);
    }
}
