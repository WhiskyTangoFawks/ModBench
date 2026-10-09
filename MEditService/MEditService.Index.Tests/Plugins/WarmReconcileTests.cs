using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

public sealed class WarmReconcileTests
{
    private static OpenedIndex OpenIndex(LoadOrderHolder holder, IPluginAdapter? adapter = null) =>
        Indexes.Open(holder, adapter);

    [Fact]
    public void ASecondLoadOfTheSameOrder_IndexesNothing_AndIsStillReadyWithWinners()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-same")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = OpenIndex(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        using var opens = new GatedPluginAdapter();
        using var warm = OpenIndex(holder, opens);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Empty(opens.Opened);
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
        using (var cold = OpenIndex(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

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
            ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null)
        {
            var index = Index
                ?? throw new InvalidOperationException("Expected the adapter's Index to be set before any open.");
            observed.Add(index.Status.IndexedPlugins.Count);
            return base.ReadContent(modPath, gameRelease, strings);
        }
    }

    [Fact]
    public void AWarmLoad_CountsEveryRegisteredPluginAsProgress()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-progress")
            .WithPlugin("A.esp").WithPlugin("B.esp").WithPlugin("C.esp")
            .Build();
        using (var cold = OpenIndex(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        using var warm = OpenIndex(holder);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(3, warm.Status.TotalPlugins);
        Assert.Equal(
            new[] { "A.esp", "B.esp", "C.esp" },
            warm.Status.IndexedPlugins.Select(p => p.Name).ToArray());
    }

    [Fact]
    public void APluginChangedBetweenLoads_IsTheOnlyOneReindexed()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-changed")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = OpenIndex(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var edited = new Fallout4Mod(ModKey.FromFileName("B.esp"), Fallout4Release.Fallout4);
        edited.Npcs.AddNew("NpcBEdited");
        edited.WriteToBinary(Path.Combine(data.DataFolder, "B.esp"));

        using var opens = new GatedPluginAdapter();
        using var warm = OpenIndex(holder, opens);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(["B.esp"], opens.Opened);
        Assert.NotEmpty(warm.ListedIn(new PluginAddress("A.esp", PluginOrigin.DataDirectory)));

        var rows = warm.ListedIn(new PluginAddress("B.esp", PluginOrigin.DataDirectory));
        Assert.Contains(rows, row => row.EditorId == "NpcBEdited");
        Assert.DoesNotContain(rows, row => row.EditorId == "NpcB");
    }

    [Fact]
    public void APluginTheIndexHasNeverSeen_IsIndexedBesideTheRegisteredOnes()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-new")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", listed: false)
            .Build();
        using (var cold = OpenIndex(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var withB = data.Plugins.Append(new LoadOrderEntry("B.esp", Path.Combine(data.DataFolder, "B.esp"), PluginOrigin.DataDirectory, Line: 99, Enabled: true, Winning: true)).ToList();

        using var opens = new GatedPluginAdapter();
        using var warm = OpenIndex(holder, opens);
        warm.Reconcile(holder, data.DataFolder, withB, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(["B.esp"], opens.Opened);
        Assert.NotEmpty(warm.ListedIn(new PluginAddress("A.esp", PluginOrigin.DataDirectory)));
        Assert.Equal(LoadOrderState.Ready, warm.Status.State);
    }

    [Fact]
    public async Task ATrackedPlugin_IsValidatedAgainstItsSourceTreeOnEveryLoad()
    {
        var holder = new LoadOrderHolder();
        const string plugin = "Tracked.esp";
        using var fixture = new PluginFixtureBuilder("warm-tracked")
            .WithPlugin(plugin, m => m.Npcs.AddNew("TrackedNpc"), origin: "TrackedMod")
            .BuildScattered()
            .Tracked();
        var entry = fixture.Plugins.Single();

        string npcSourceFile;
        using (var second = OpenIndex(holder))
        {
            second.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4, fixture.InstanceRoot);
            var npc = second.ListedIn(entry.KeyOf()).Single(row => row.EditorId == "TrackedNpc");
            npcSourceFile = entry.SourceFileOf(second.DocumentOf(npc.FormKey, entry.KeyOf()));
        }

        using var third = OpenIndex(holder);
        third.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4, fixture.InstanceRoot);

        Assert.Empty(third.Status.Failures);

        var text = await File.ReadAllTextAsync(npcSourceFile);
        await File.WriteAllTextAsync(
            npcSourceFile, text.Replace("\"TrackedNpc\"", "\"EditedBetweenLoads\"", StringComparison.Ordinal));
        using var fourth = OpenIndex(holder);
        fourth.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4, fixture.InstanceRoot);
        Assert.Contains(
            fourth.ListedIn(entry.KeyOf()), row => row.EditorId == "EditedBetweenLoads");
    }
}
