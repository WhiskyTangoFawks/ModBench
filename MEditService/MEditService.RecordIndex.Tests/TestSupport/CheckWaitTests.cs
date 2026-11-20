using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.TestSupport;

public sealed class CheckWaitTests
{
    private static readonly Dictionary<string, Action<OpenedIndex>> Waits = new()
    {
        ["the next check"] = index => index.NextCheck(),
        ["the next check until"] = index => index.NextCheckUntil(() => false, "an answer the failed check never gives"),
        ["the next check unsettled until"] = index => index.NextCheckUnsettledUntil(() => false, "an answer the failed check never gives"),
    };

    [Theory]
    [InlineData("the next check")]
    [InlineData("the next check until")]
    [InlineData("the next check unsettled until")]
    public void ACheckThatFailedAPlugin_FailsTheWaitOnIt_NamingTheFailure(string wait)
    {
        using var fixture = new PluginFixtureBuilder($"check-wait-{wait.Replace(' ', '-')}")
            .WithPlugin("Checked.esp", mod => mod.Npcs.AddNew("CheckedNpc"), origin: "CheckedMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        File.WriteAllText(fixture.Plugins.Single().Path, "not a plugin");

        var thrown = Record.Exception(() => Waits[wait](index));

        Assert.NotNull(thrown);
        Assert.Contains("Checked.esp", thrown.Message, StringComparison.Ordinal);
        Assert.Contains("Could not read enough data to parse a Mod Header", thrown.Message, StringComparison.Ordinal);
    }
}
