using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
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
    public void ALaunchWithNothingChanged_OpensHashesAndCountsNoPlugin_AndAdvancesTheSequenceOnlyForTheWinnerSweep()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-same")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        long launched;
        using (var cold = Indexes.Open(holder, new CountingAdapter()))
        {
            cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
            launched = cold.Sequence;
        }

        var work = new CountingAdapter();
        using var warm = Indexes.Open(holder, work);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Empty(work.Opened);
        Assert.Empty(work.Hashed);
        Assert.Empty(work.Counted);
        Assert.Equal(launched + 1, warm.Sequence);
        Assert.Equal(LoadOrderState.Ready, warm.Status.State);
        Assert.Equal(["A.esp", "B.esp"], warm.Status.IndexedPlugins.Select(p => p.Name));
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
    public void APluginClaimedJustAfterItWasWritten_IsHashedByTheNextLaunchAlone()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-restamped")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .Build();
        var clockStoppedAtTheWrite = new MutagenPluginAdapter(new FakeTimeProvider(TimeProvider.System.GetUtcNow()));
        using (var cold = Indexes.Open(holder, clockStoppedAtTheWrite)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var next = new CountingAdapter();
        using (var launch = Indexes.Open(holder, next)) launch.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var after = new CountingAdapter();
        using (var launch = Indexes.Open(holder, after)) launch.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(["A.esp"], next.Hashed.Distinct());
        Assert.Empty(after.Hashed);
    }

    [Fact]
    public async Task APluginReadWholeAgain_SweepsTheWinnersOfItsOwnRecordsAlone()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("whole-read-sweep")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var b = data.Plugins.Single(p => p.Name == "B.esp");
        PluginBinaries.Rewrite(b.Path, m => m.Npcs.AddNew("NpcBAgain"));
        IndexFiles.LogQueries(data.InstanceRoot);

        Assert.Null(await index.Queries.Hold([HandedPlugin.ReadBack(b.Key)], CancellationToken.None));

        Assert.Equal(["NpcBAgain"], index.ListedIn(b.Key).Select(r => r.EditorId));
        Assert.True(IndexFiles.Started(data.InstanceRoot, "DELETE FROM winners WHERE form_key IN"));
        Assert.False(IndexFiles.Started(data.InstanceRoot, "DELETE FROM winners WHERE TRUE"));
    }

    [Fact]
    public void ALaunchAfterAPluginChangedOnDisk_HashesIt_AndReadsItAgain()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-rehashed")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = Indexes.Open(holder, new CountingAdapter())) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var b = data.Plugins.Single(p => p.Name == "B.esp");
        PluginBinaries.Rewrite(b.Path, m => m.Npcs.AddNew("NpcBAgain"));

        var hashes = new CountingAdapter();
        using var warm = Indexes.Open(holder, hashes);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(["B.esp"], hashes.Hashed.Distinct());
        Assert.Equal(["NpcBAgain"], warm.ListedIn(b.Key).Select(r => r.EditorId));
    }

    /// <summary>Each plugin hashed, counted and opened, over a clock past every write, so a stamp vouches for its file.</summary>
    private sealed class CountingAdapter() : DelegatingPluginAdapter(new MutagenPluginAdapter(ClockPastEveryWrite))
    {
        public List<string> Hashed { get; } = [];

        public List<string> Counted { get; } = [];

        public List<string> Opened { get; } = [];

        private static void Add(List<string> work, string path)
        {
            lock (work) work.Add(Path.GetFileName(path));
        }

        public override string? HashOf(string pluginPath)
        {
            Add(Hashed, pluginPath);
            return base.HashOf(pluginPath);
        }

        public override Answer<(int Count, PluginFailure? Unreachable), PluginFailure> CountRecords(ModPath modPath, LoadOrderSnapshot loadOrder)
        {
            Add(Counted, modPath.Path);
            return base.CountRecords(modPath, loadOrder);
        }

        public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
            ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas, PluginStrings strings)
        {
            Add(Opened, modPath.Path);
            return base.OpenDocuments(modPath, loadOrder, schemas, strings);
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

        using (var warm = Indexes.Open(holder, loggerFactory: loggers))
        {
            warm.Reconcile(holder, data.DataFolder, [.. data.Plugins.Select((p, at) => p with { Line = data.Plugins.Count - at })], GameRelease.Fallout4, data.InstanceRoot);
            Waits.Reached(() => { lock (log) return log.Exists(e => e.Message.StartsWith("Checkpointed the record index", StringComparison.Ordinal)); }, "the checkpoint");
        }

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
