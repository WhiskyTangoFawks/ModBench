using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Indexing;

public class PluginParticipationTests
{
    private static PluginFixtureData SharedNpcFixture(string prefix, out FormKey npcKey, bool pluginBEnabled = true)
    {
        FormKey key = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("PluginA.esm", mod => key = mod.Npcs.AddNew("SharedNPC").FormKey)
            .WithPlugin("PluginB.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("PluginA.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            }, enabled: pluginBEnabled)
            .Build();
        npcKey = key;
        return fixture;
    }

    private static IReadOnlyList<LoadOrderEntry> WithBDisabled(PluginFixtureData fixture) =>
        [.. fixture.Plugins.Select(p => p.Name == "PluginB.esp" ? p with { Enabled = false } : p)];

    private static Dictionary<string, bool> WinnersByPlugin(OpenedIndex index, FormKey npcKey) =>
        index.RequireReads().GetOverrideStack(npcKey.ToString())?.Entries.ToDictionary(o => o.Plugin.Name, o => o.IsWinner) ?? [];

    [Fact]
    public void DisablingAPluginByReconcile_MatchesIndexingItDisabledFromStart()
    {
        using var fixtureX = SharedNpcFixture("participation-flip-x", out var npcKeyX);
        using var fixtureY = SharedNpcFixture("participation-flip-y", out var npcKeyY, pluginBEnabled: false);

        var holder = new LoadOrderHolder();
        using var flipped = Indexes.Open(holder);
        flipped.Reconcile(holder, fixtureX.DataFolder, fixtureX.Plugins, GameRelease.Fallout4);
        flipped.Reconcile(holder, fixtureX.DataFolder, WithBDisabled(fixtureX), GameRelease.Fallout4);

        using var fromStart = Indexes.Reconciled(fixtureY);

        var flippedWinners = WinnersByPlugin(flipped, npcKeyX);
        var fromStartWinners = WinnersByPlugin(fromStart, npcKeyY);

        Assert.Equal(fromStartWinners, flippedWinners);
        Assert.Equal(new Dictionary<string, bool> { ["PluginA.esm"] = true }, flippedWinners);
    }

    [Fact]
    public void ADisabledPluginsSnapshotArrivingAgain_LeavesTheWinnersAsTheyWere()
    {
        using var fixture = SharedNpcFixture("participation-idempotent", out var npcKey);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);

        index.Reconcile(holder, fixture.DataFolder, WithBDisabled(fixture), GameRelease.Fallout4);
        var afterTheFlip = WinnersByPlugin(index, npcKey);

        PluginBinaries.Touch(fixture.Plugins[0].Path);
        index.NextSnapshot();
        var afterTheSnapshotArrivedAgain = WinnersByPlugin(index, npcKey);

        Assert.Equal(afterTheFlip, afterTheSnapshotArrivedAgain);
    }

    [Fact]
    public void DisabledOnlyFormKey_IsReadNowhere()
    {
        FormKey npcKey = default;
        using var fixture = new PluginFixtureBuilder("participation-lone")
            .WithPlugin("Disabled.esp", mod => npcKey = mod.Npcs.AddNew("OnlyInDisabled").FormKey, enabled: false)
            .Build();
        using var index = Indexes.Reconciled(fixture);

        Assert.Null(index.RequireReads().GetOverrideStack(npcKey.ToString()));
        Assert.Null(index.RequireReads().GetDocument(npcKey.ToString()));
    }

    [Fact]
    public void DisabledOnlyFormKey_DoesNotResolve()
    {
        FormKey npcKey = default;
        using var fixture = new PluginFixtureBuilder("participation-lookup")
            .WithPlugin("Disabled.esp", mod => npcKey = mod.Npcs.AddNew("OnlyInDisabled").FormKey, enabled: false)
            .Build();
        using var index = Indexes.Reconciled(fixture);

        Assert.Null(index.RequireReads().LinkResolver(npcKey.ToString())(npcKey.ToString()));
    }
}
