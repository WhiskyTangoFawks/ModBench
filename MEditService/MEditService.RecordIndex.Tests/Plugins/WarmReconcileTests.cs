using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class WarmReconcileTests
{
    [Fact]
    public void ASecondLoadOfTheSameOrder_IndexesNothing_AndIsStillReadyWithWinners()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-same")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = Indexes.Open(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        using var opens = new GatedPluginAdapter();
        using var warm = Indexes.Open(holder, opens);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Empty(opens.Opened);
        Assert.Equal(2, warm.Status.TotalPlugins);
        Assert.Equal(["A.esp", "B.esp"], warm.Status.IndexedPlugins.Select(p => p.Name));

        Assert.Equal(LoadOrderState.Ready, warm.Status.State);
        Assert.True(warm.Status.ConflictsComputed);
        Assert.NotEmpty(warm.ListedIn(new PluginAddress("A.esp", PluginOrigin.DataDirectory)));
    }

    [Fact]
    public void AWarmLoad_AdvancesProgressAsEachPluginIsRegistered()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-during")
            .WithPlugin("A.esp").WithPlugin("B.esp").WithPlugin("C.esp")
            .Build();
        using (var cold = Indexes.Open(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var observed = new List<int>();
        var watching = new ProgressWatchingAdapter(observed);
        using var warm = Indexes.Open(holder, watching);
        watching.Index = warm;

        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal([0, 1, 2], observed);
    }

    private sealed class ProgressWatchingAdapter(List<int> observed) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public OpenedIndex? Index { get; set; }

        public override Answer<(PluginContent Content, PluginFailure? Unreachable), PluginFailure> ReadContent(
            ModPath modPath, LoadOrderSnapshot loadOrder, PluginStrings strings)
        {
            var index = Index
                ?? throw new InvalidOperationException("Expected the adapter's Index to be set before any open.");
            observed.Add(index.Status.IndexedPlugins.Count);
            return base.ReadContent(modPath, loadOrder, strings);
        }
    }

    [Fact]
    public void APluginTheIndexHasNeverSeen_IsIndexedBesideTheRegisteredOnes()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-new")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", listed: false)
            .Build();
        using (var cold = Indexes.Open(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var withB = data.Plugins.Append(new LoadOrderEntry("B.esp", Path.Combine(data.DataFolder, "B.esp"), PluginOrigin.DataDirectory, Line: 99, Enabled: true, Winning: true)).ToList();

        using var opens = new GatedPluginAdapter();
        using var warm = Indexes.Open(holder, opens);
        warm.Reconcile(holder, data.DataFolder, withB, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(["B.esp"], opens.Opened);
        Assert.NotEmpty(warm.ListedIn(new PluginAddress("A.esp", PluginOrigin.DataDirectory)));
        Assert.Equal(LoadOrderState.Ready, warm.Status.State);
    }
}
