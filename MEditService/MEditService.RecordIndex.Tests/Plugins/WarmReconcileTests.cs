using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
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
    public void AWarmLoadPastTheTimeArrivalsLandTogether_AdvancesProgressAsEachPluginIsRegistered()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-during")
            .WithPlugin("A.esp").WithPlugin("B.esp").WithPlugin("C.esp")
            .Build();
        using (var cold = Indexes.Open(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var observed = new List<int>();
        var watching = new ProgressWatchingAdapter(observed);
        var clock = new LeapingClock();
        using var warm = Indexes.Open(holder, watching, timeProvider: clock);
        watching.Index = warm;

        clock.StartLeaping();
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        clock.StopLeaping();

        Assert.Equal([0, 1, 2], observed);
    }

    [Fact]
    public void AProfileSwitch_LandsThePluginsIndexedBeforeTogether_WithTheFiltersMatchesInThem()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-switch")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("FromC"))
            .Build();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        index.Reconcile(holder, data.DataFolder, data.Plugins.Take(1).ToList(), GameRelease.Fallout4, data.InstanceRoot);
        index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        var switched = index.Sequence;

        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(switched + 2, index.Sequence);
        Assert.Equal(3, index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value().Total);
    }

    [Fact]
    public void ALaunchWithNothingChanged_AdvancesTheSequenceOnlyForTheWinnerSweep()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-unwritten")
            .WithPlugin("A.esp").WithPlugin("B.esp").WithPlugin("C.esp")
            .Build();
        long launched;
        using (var cold = Indexes.Open(holder))
        {
            cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
            launched = cold.Sequence;
        }

        using var warm = Indexes.Open(holder);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(launched + 1, warm.Sequence);
    }

    [Fact]
    public void ALaunchWithNothingChanged_CountsNoPluginsRecords()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-uncounted")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        var counts = new RecordCountingAdapter();
        using (var cold = Indexes.Open(holder, counts)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        Assert.NotEmpty(counts.Counted);
        counts.Counted.Clear();

        using var warm = Indexes.Open(holder, counts);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Empty(counts.Counted);
    }

    [Fact]
    public void ALaunchLandingItsCompiledPluginsLast_ReadsTheirDocumentStampsOnce()
    {
        using var data = new PluginFixtureBuilder("warm-trees-last")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"), origin: "ModA")
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"), origin: "ModB")
            .WithPlugin("C.esp", m => m.Npcs.AddNew("NpcC"), origin: "ModC")
            .WithPlugin("D.esp", m => m.Npcs.AddNew("NpcD"), origin: "ModD")
            .BuildScattered();
        SourceMods.Init(data.Plugins.Single(p => p.Name == "C.esp"));
        SourceMods.Init(data.Plugins.Single(p => p.Name == "D.esp"));
        var trees = TestAdapters.Source(ClockPastEveryWrite);
        using (Indexes.Reconciled(data, data.InstanceRoot, source: trees)) { }

        var clock = new LeapingClock();
        var holder = new LoadOrderHolder();
        using var warm = Indexes.Open(holder, new QueryLoggingAdapter(data.InstanceRoot), timeProvider: clock, source: trees);
        clock.StartLeaping();
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        clock.StopLeaping();

        Assert.Equal(1, IndexFiles.StartedCount(data.InstanceRoot, "AS plugin, unnest($2::VARCHAR[]) AS origin) k"));
        Assert.Equal(4, warm.Status.IndexedPlugins.Count);
    }

    [Fact]
    public void ACheckAfterAnEdit_ReadsStampsInFewerQueriesThanThereArePlugins()
    {
        var npc = "";
        using var data = new PluginFixtureBuilder("check-stamps-once")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"), origin: "ModA")
            .WithPlugin("B.esp", m => npc = m.Npcs.AddNew("NpcB").FormKey.ToString(), origin: "ModB")
            .WithPlugin("C.esp", m => m.Npcs.AddNew("NpcC"), origin: "ModC")
            .WithPlugin("D.esp", m => m.Npcs.AddNew("NpcD"), origin: "ModD")
            .BuildScattered();
        var edited = data.Plugins.Single(p => p.Name == "B.esp");
        SourceMods.Init(edited);
        using var index = Indexes.Reconciled(data, data.InstanceRoot);
        IndexFiles.LogQueries(data.InstanceRoot);

        edited.HandEdit(index.DocumentOf(npc, edited.Key), "\"NpcB\"", "\"EditedB\"");
        index.SignalChange();
        Waits.Reached(() => index.DocumentOf(npc, edited.Key).EditorId == "EditedB", "the edit reaching reads");
        Waits.Reached(() => index.Status.State == LoadOrderState.Ready, "the check ending");

        Assert.True(IndexFiles.StartedCount(data.InstanceRoot, "SELECT plugin, origin, derived_from FROM") < data.Plugins.Count);
    }

    private sealed class QueryLoggingAdapter(string instanceRoot) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        private int _logging;

        public override bool Exists(string pluginPath)
        {
            if (Interlocked.Exchange(ref _logging, 1) == 0) IndexFiles.LogQueries(instanceRoot);
            return base.Exists(pluginPath);
        }
    }

    private static readonly FakeTimeProvider ClockPastEveryWrite = new(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1));

    [Fact]
    public void ALaunchWithNothingChanged_HashesNoPlugin()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-unhashed")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = Indexes.Open(holder, new HashCountingAdapter())) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var hashes = new HashCountingAdapter();
        using var warm = Indexes.Open(holder, hashes);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Empty(hashes.Hashed);
        Assert.Equal(["A.esp", "B.esp"], warm.Status.IndexedPlugins.Select(p => p.Name));
    }

    [Fact]
    public void APluginClaimedJustAfterItWasWritten_IsHashedByTheNextLaunchAlone()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-restamped")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .Build();
        using (var cold = Indexes.Open(holder, TestAdapters.Mutagen())) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var next = new HashCountingAdapter();
        using (var launch = Indexes.Open(holder, next)) launch.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var after = new HashCountingAdapter();
        using (var launch = Indexes.Open(holder, after)) launch.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(["A.esp"], next.Hashed.Distinct());
        Assert.Empty(after.Hashed);
    }

    [Fact]
    public void ALaunchAfterAPluginChangedOnDisk_HashesIt_AndReadsItAgain()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-rehashed")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = Indexes.Open(holder, new HashCountingAdapter())) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var b = data.Plugins.Single(p => p.Name == "B.esp");
        PluginBinaries.Rewrite(b.Path, m => m.Npcs.AddNew("NpcBAgain"));

        var hashes = new HashCountingAdapter();
        using var warm = Indexes.Open(holder, hashes);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(["B.esp"], hashes.Hashed.Distinct());
        Assert.Equal(["NpcBAgain"], warm.ListedIn(b.Key).Select(r => r.EditorId));
    }

    private sealed class HashCountingAdapter() : DelegatingPluginAdapter(new MutagenPluginAdapter(ClockPastEveryWrite))
    {
        public List<string> Hashed { get; } = [];

        public override string? HashOf(string pluginPath)
        {
            lock (Hashed) Hashed.Add(Path.GetFileName(pluginPath));
            return base.HashOf(pluginPath);
        }
    }

    private sealed class RecordCountingAdapter() : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public List<string> Counted { get; } = [];

        public override Answer<(int Count, PluginFailure? Unreachable), PluginFailure> CountRecords(ModPath modPath, LoadOrderSnapshot loadOrder)
        {
            Counted.Add(modPath.ModKey.FileName.String);
            return base.CountRecords(modPath, loadOrder);
        }
    }

    [Fact]
    public void ALaunchThatReordersThePlugins_CheckpointsOnceForTheWinnerSweep()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-reordered")
            .WithPlugin("A.esp").WithPlugin("B.esp").WithPlugin("C.esp")
            .Build();
        using (var cold = Indexes.Open(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var log = new List<LogEntry>();
        using var loggers = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(log)));

        using var warm = Indexes.Open(holder, loggerFactory: loggers);
        warm.Reconcile(holder, data.DataFolder, [.. data.Plugins.Select((p, at) => p with { Line = data.Plugins.Count - at })], GameRelease.Fallout4, data.InstanceRoot);

        lock (log) Assert.Single(log, e => e.Message.StartsWith("Checkpointed the record index", StringComparison.Ordinal));
    }

    private sealed class ProgressWatchingAdapter(List<int> observed) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public OpenedIndex? Index { get; set; }

        public override Answer<PluginContent, PluginFailure> ReadContent(
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
