using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

public sealed class WarmReconcileTests
{
    private static OpenedIndex MakeIndexer(LoadOrderHolder holder, ILoggerFactory? loggerFactory = null) =>
        Indexes.Open(holder, loggerFactory: loggerFactory);

    private static (ILoggerFactory Factory, List<LogEntry> Entries) Capturing()
    {
        var entries = new List<LogEntry>();
        var factory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Debug);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });
        return (factory, entries);
    }

    private static int Indexed(List<LogEntry> entries, string plugin) =>
        entries.Count(e => e.Message.StartsWith($"Indexing {plugin} ", StringComparison.Ordinal));

    private static int Registered(List<LogEntry> entries, string plugin) =>
        entries.Count(e => e.Message.StartsWith($"Registering {plugin} ", StringComparison.Ordinal));

    [Fact]
    public void ASecondLoadOfTheSameOrder_IndexesNothing_AndIsStillReadyWithWinners()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-same")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = MakeIndexer(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var warm = MakeIndexer(holder, loggerFactory);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(0, Indexed(entries, "A.esp"));
        Assert.Equal(0, Indexed(entries, "B.esp"));
        Assert.Equal(1, Registered(entries, "A.esp"));
        Assert.Equal(1, Registered(entries, "B.esp"));

        Assert.Equal(LoadOrderState.Ready, warm.Status.State);
        Assert.True(warm.Status.ConflictsComputed);
        Assert.NotEmpty(warm.RequireReads().GetDocuments(new PluginAddress("A.esp", PluginOrigin.DataDirectory)));
    }

    [Fact]
    public void AWarmLoad_AdvancesProgressAsEachPluginIsRegistered()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-during")
            .WithPlugin("A.esp").WithPlugin("B.esp").WithPlugin("C.esp")
            .Build();
        using (var cold = MakeIndexer(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

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

        public override (PluginContent Content, Exception? Unreachable) ReadContent(
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
        using (var cold = MakeIndexer(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        using var warm = MakeIndexer(holder);
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
        using (var cold = MakeIndexer(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var edited = new Fallout4Mod(ModKey.FromFileName("B.esp"), Fallout4Release.Fallout4);
        edited.Npcs.AddNew("NpcBEdited");
        edited.WriteToBinary(Path.Combine(data.DataFolder, "B.esp"));

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var warm = MakeIndexer(holder, loggerFactory);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(1, Registered(entries, "A.esp"));
        Assert.Equal(0, Indexed(entries, "A.esp"));
        Assert.Equal(1, Indexed(entries, "B.esp"));
        Assert.Equal(0, Registered(entries, "B.esp"));

        var documents = warm.RequireReads().GetDocuments(new PluginAddress("B.esp", PluginOrigin.DataDirectory));
        Assert.Contains(documents, d => d.EditorId == "NpcBEdited");
        Assert.DoesNotContain(documents, d => d.EditorId == "NpcB");
    }

    [Fact]
    public void APluginTheIndexHasNeverSeen_IsIndexedBesideTheRegisteredOnes()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-new")
            .WithPlugin("A.esp")
            .WithPlugin("B.esp", listed: false)
            .Build();
        using (var cold = MakeIndexer(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var withB = data.Plugins.Append(new LoadOrderEntry("B.esp", Path.Combine(data.DataFolder, "B.esp"), PluginOrigin.DataDirectory, Slot: 99, Enabled: true, Winning: true)).ToList();

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var warm = MakeIndexer(holder, loggerFactory);
        warm.Reconcile(holder, data.DataFolder, withB, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(1, Registered(entries, "A.esp"));
        Assert.Equal(1, Indexed(entries, "B.esp"));
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
        using (var second = MakeIndexer(holder))
        {
            second.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4, fixture.InstanceRoot);
            npcSourceFile = entry.SourceFileOf(
                second.RequireReads().GetDocuments(entry.KeyOf()).Single(d => d.EditorId == "TrackedNpc"));
        }

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var third = MakeIndexer(holder, loggerFactory);
        third.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4, fixture.InstanceRoot);

        Assert.Equal(1, Registered(entries, plugin));
        Assert.Equal(0, Indexed(entries, plugin));
        Assert.Empty(third.Status.Failures);

        var text = await File.ReadAllTextAsync(npcSourceFile);
        await File.WriteAllTextAsync(
            npcSourceFile, text.Replace("\"TrackedNpc\"", "\"EditedBetweenLoads\"", StringComparison.Ordinal));
        using var fourth = MakeIndexer(holder);
        fourth.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4, fixture.InstanceRoot);
        Assert.Contains(
            fourth.RequireReads().GetDocuments(entry.KeyOf()), d => d.EditorId == "EditedBetweenLoads");
    }
}
