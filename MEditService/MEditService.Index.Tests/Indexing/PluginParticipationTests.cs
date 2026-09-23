using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Indexing;

// ADR-0013: the winner sweep carries a participation predicate: an indexed-but-non-participating
// plugin's copy can never be a winner, regardless of its slot.
public class PluginParticipationTests
{
    // PluginA.esm defines SharedNPC; PluginB.esp overrides it. Deterministic FormID assignment
    // means npcKey is identical across independently-built fixtures, so two indexes built from two
    // calls to this helper can be compared directly by (plugin -> IsWinner).
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

    private static Dictionary<string, bool> WinnersByPlugin(Indexer index, FormKey npcKey) =>
        index.RequireReads().GetOverrideStack(npcKey.ToString())?.Entries.ToDictionary(o => o.Plugin.Name, o => o.IsWinner) ?? [];

    [Fact]
    public void DisabledPlugin_LaterInLoadOrder_DoesNotDisplaceEnabledWinner()
    {
        // PluginB sits last in the load order (highest slot) but is disabled — a bare MAX(slot)
        // sweep would incorrectly make it the winner.
        using var fixture = SharedNpcFixture("participation-winner", out var npcKey, pluginBEnabled: false);
        using var index = Indexes.Reconciled(fixture);

        var overrideStack = index.RequireReads().GetOverrideStack(npcKey.ToString())
            ?? throw new InvalidOperationException($"Expected an override stack for indexed record '{npcKey}'.");
        var overrides = overrideStack.Entries;

        Assert.Equal(2, overrides.Count);
        var pluginA = overrides.Single(o => o.Plugin.Name == "PluginA.esm");
        var pluginB = overrides.Single(o => o.Plugin.Name == "PluginB.esp");
        Assert.True(pluginA.IsWinner);
        Assert.False(pluginB.IsWinner);
    }

    [Fact]
    public void SetPluginParticipation_FlipToDisabled_MatchesLoadingDisabledFromStart()
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
        Assert.False(flippedWinners["PluginB.esp"]);
        Assert.True(flippedWinners["PluginA.esm"]);
    }

    [Fact]
    public void SetPluginParticipation_FlippedTwice_IsIdempotent()
    {
        using var fixture = SharedNpcFixture("participation-idempotent", out var npcKey);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);

        index.Reconcile(holder, fixture.DataFolder, WithBDisabled(fixture), GameRelease.Fallout4);
        var afterFirstFlip = WinnersByPlugin(index, npcKey);

        index.Reconcile(holder, fixture.DataFolder, WithBDisabled(fixture), GameRelease.Fallout4);
        var afterSecondFlip = WinnersByPlugin(index, npcKey);

        Assert.Equal(afterFirstFlip, afterSecondFlip);
    }

    [Fact]
    public void DisabledOnlyFormKey_HasNoWinner()
    {
        FormKey npcKey = default;
        using var fixture = new PluginFixtureBuilder("participation-lone")
            .WithPlugin("Disabled.esp", mod => npcKey = mod.Npcs.AddNew("OnlyInDisabled").FormKey, enabled: false)
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var record = index.RequireReads().GetDocument(npcKey.ToString(), new PluginCopyKey("Disabled.esp", "Data"));

        Assert.NotNull(record);
        Assert.False(record.IsWinner);
    }

    [Fact]
    public void DisabledOnlyFormKey_DoesNotResolve()
    {
        FormKey npcKey = default;
        using var fixture = new PluginFixtureBuilder("participation-lookup")
            .WithPlugin("Disabled.esp", mod => npcKey = mod.Npcs.AddNew("OnlyInDisabled").FormKey, enabled: false)
            .Build();
        using var index = Indexes.Reconciled(fixture);

        Assert.Null(index.RequireReads().Resolve(npcKey.ToString()));
    }
}
