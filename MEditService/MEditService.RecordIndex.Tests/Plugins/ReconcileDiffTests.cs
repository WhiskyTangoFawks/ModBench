using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class ReconcileDiffTests
{
    private static (OpenedIndex Index, GatedPluginAdapter Opens) MakeIndex(LoadOrderHolder holder)
    {
        var opens = new GatedPluginAdapter();
        return (Indexes.Open(holder, opens), opens);
    }

    private static ScatteredFixtureData TwoProviders(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin("A.esm", mod => mod.Npcs.AddNew("SharedNPC"))
            .WithPlugin("B.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("A.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            })
            .BuildScattered();

    private static PluginAddress Key(ScatteredFixtureData fx, string name) => fx.Plugins.Single(p => p.Name == name).Key;

    private static string SharedNpc(OpenedIndex index, ScatteredFixtureData fx) =>
        index.Queries.GetRecords(["npc_"], Key(fx, "A.esm"), search: null, limit: 10, offset: 0).Value().Items.Single().FormKey;

    private static string WinnerOf(OpenedIndex index, string formKey) =>
        index.StackOf(formKey).Single(copy => copy.IsWinner).Plugin;

    private static IReadOnlyList<(string FormKey, string Body)> Bodies(OpenedIndex index, PluginAddress plugin) =>
        [.. index.ListedIn(plugin).Select(row => (row.FormKey, index.BodyOf(row.FormKey, plugin)))];

    private static IReadOnlyList<LoadOrderEntry> With(IReadOnlyList<LoadOrderEntry> plugins, string name, Func<LoadOrderEntry, LoadOrderEntry> change) =>
        plugins.Select(p => p.Name == name ? change(p) : p).ToList();

    [Fact]
    public void Reorder_OpensNoPlugin_AndWinnersFollowTheNewOrder()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-reorder");
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;
        index.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4);
        var npc = SharedNpc(index, fx);
        Assert.Equal("B.esp", WinnerOf(index, npc));
        var opened = opens.OpenedTotal;
        var sequence = index.Sequence;
        var aKey = Key(fx, "A.esm");
        var bKey = Key(fx, "B.esp");
        var bodiesBefore = (A: Bodies(index, aKey), B: Bodies(index, bKey));

        var swapped = fx.Plugins.Select(p => p with { Line = p.Name == "A.esm" ? 1 : 0 }).ToList();
        index.Reconcile(holder, fx.DataFolder, swapped, GameRelease.Fallout4);

        Assert.Equal(opened, opens.OpenedTotal);
        Assert.Equal("A.esm", WinnerOf(index, npc));
        Assert.True(index.Sequence > sequence, "a reorder is a sweep, and a sweep is a projection");
        Assert.Equal(bodiesBefore.A, Bodies(index, aKey));
        Assert.Equal(bodiesBefore.B, Bodies(index, bKey));
    }

    [Fact]
    public void Disable_OpensNoPlugin_TheDisabledPluginIsReadNowhere_AndTheOtherProviderWins()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-disable");
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;
        index.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4);
        var npc = SharedNpc(index, fx);
        var opened = opens.OpenedTotal;
        var bKey = Key(fx, "B.esp");

        index.Reconcile(holder, fx.DataFolder, With(fx.Plugins, "B.esp", p => p with { Enabled = false }), GameRelease.Fallout4);

        Assert.Equal(opened, opens.OpenedTotal);
        Assert.Empty(index.ListedIn(bKey));
        Assert.NotNull(index.PluginResponseOf(bKey));
        Assert.Equal("A.esm", WinnerOf(index, npc));

        index.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4);
        Assert.Equal(opened, opens.OpenedTotal);
        Assert.Equal("B.esp", WinnerOf(index, npc));
    }

    [Fact]
    public void OverriddenPlugin_IsHeldBesideTheWinner_NeverWins_AndReprioritisingFlipsTheWinnerWithoutOpeningAPlugin()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("reconcile-losing")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB"), origin: "ModB")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();
        var snapshot = fx.Plugins;
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;

        index.Reconcile(holder, fx.DataFolder, snapshot, GameRelease.Fallout4);

        var modA = new PluginAddress("Shared.esp", "ModA");
        var modB = new PluginAddress("Shared.esp", "ModB");
        var only = Assert.Single(index.StackOf("000800:Shared.esp"));
        Assert.Equal(modA, new PluginAddress(only.Plugin, only.Origin));
        Assert.True(only.IsWinner);
        Assert.NotNull(index.PluginResponseOf(modB));

        var opened = opens.OpenedTotal;
        var flipped = snapshot.Select(p => p with { Winning = p.Origin == "ModB" }).ToList();
        index.Reconcile(holder, fx.DataFolder, flipped, GameRelease.Fallout4);
        only = Assert.Single(index.StackOf("000800:Shared.esp"));
        Assert.Equal(modB, new PluginAddress(only.Plugin, only.Origin));
        Assert.True(only.IsWinner);
        Assert.Equal(opened, opens.OpenedTotal);
    }

    [Fact]
    public void PluginAbsentFromSnapshot_IsUnregistered_AndReturnsWithoutAReindex()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-leave");
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;
        index.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4);
        var npc = SharedNpc(index, fx);
        var opened = opens.OpenedTotal;
        var bKey = Key(fx, "B.esp");

        index.Reconcile(holder, fx.DataFolder, fx.Plugins.Where(p => p.Name != "B.esp").ToList(), GameRelease.Fallout4);

        Assert.Null(index.PluginResponseOf(bKey));
        Assert.Empty(index.ListedIn(bKey));
        Assert.DoesNotContain(index.Status.IndexedPlugins, p => p.Name == "B.esp");
        Assert.Equal("A.esm", WinnerOf(index, npc));

        index.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4);

        Assert.Equal(opened, opens.OpenedTotal);
        Assert.NotNull(index.PluginResponseOf(bKey));
        Assert.Equal("B.esp", WinnerOf(index, npc));
    }

    [Fact]
    public void AfterRestart_IdenticalSnapshot_ReindexesNothing_AndADifferentOne_CorrectsTheRegistrations()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-restart");
        var (first, firstOpens) = MakeIndex(holder);
        using (first)
        using (firstOpens)
        {
            first.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4, fx.InstanceRoot);
        }

        var (second, opens) = MakeIndex(holder);
        using (second)
        using (opens)
        {
            second.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4, fx.InstanceRoot);

            Assert.Equal(0, opens.OpenedTotal);
            Assert.Equal("B.esp", WinnerOf(second, SharedNpc(second, fx)));
            Assert.Equal(fx.Plugins.Count, second.Status.IndexedPlugins.Count);
        }

        var (third, thirdOpens) = MakeIndex(holder);
        using (third)
        using (thirdOpens)
        {
            third.Reconcile(holder, fx.DataFolder, fx.Plugins.Where(p => p.Name != "B.esp").ToList(), GameRelease.Fallout4, fx.InstanceRoot);

            Assert.Equal(0, thirdOpens.OpenedTotal);
            Assert.Empty(third.ListedIn(Key(fx, "B.esp")));
            Assert.Equal("A.esm", WinnerOf(third, SharedNpc(third, fx)));
        }
    }
}
