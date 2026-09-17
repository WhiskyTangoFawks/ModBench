using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Plugins;

// ADR-0009: loading a load order the index has seen registers its plugins rather than indexing them.
public sealed class WarmReconcileTests
{
    private static IndexProjector MakeManager(LoadOrderHolder holder, ILoggerFactory? loggerFactory = null) =>
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

    // A warm launch pays for no indexing at all, and still arrives at a fully
    // loaded load order — Ready, winners swept, records answering.
    [Fact]
    public void ASecondLoadOfTheSameOrder_IndexesNothing_AndIsStillReadyWithWinners()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-same")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = MakeManager(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var warm = MakeManager(holder, loggerFactory);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(0, Indexed(entries, "A.esp"));
        Assert.Equal(0, Indexed(entries, "B.esp"));
        Assert.Equal(1, Registered(entries, "A.esp"));
        Assert.Equal(1, Registered(entries, "B.esp"));

        Assert.Equal(LoadOrderState.Ready, warm.Status.State);
        Assert.True(warm.Status.ConflictsComputed);
        Assert.NotEmpty(warm.RequireReads().GetDocuments(new PluginCopyKey("A.esp", PluginOrigin.DataDirectory)));
    }

    // The "during" half of progress, observed from inside the load loop. A load publishing its count
    // only at the end would satisfy the final-state assertion and still leave a warm launch at zero.
    [Fact]
    public void AWarmLoad_AdvancesProgressAsEachPluginIsRegistered()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-during")
            .WithPlugin("A.esp").WithPlugin("B.esp").WithPlugin("C.esp")
            .Build();
        using (var cold = MakeManager(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var observed = new List<int>();
        var watching = new ProgressWatchingAdapter(observed);
        using var warm = Indexes.Open(holder, watching);
        watching.Index = warm;

        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        // Each open saw the plugins that had already landed and no more.
        Assert.Equal([0, 1, 2], observed);
    }

    // Every copy's open, the step before its registration, is asked how much progress the load
    // order was reporting at that moment.
    private sealed class ProgressWatchingAdapter(List<int> observed) : DelegatingPluginAdapter(MutagenPluginAdapter.Instance)
    {
        public IndexProjector? Index { get; set; }

        public override (PluginContent Content, Exception? Unreachable) ReadContent(
            ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null)
        {
            var index = Index
                ?? throw new InvalidOperationException("Expected the adapter's Index to be set before any open.");
            observed.Add(index.Status.IndexedPlugins.Count);
            return base.ReadContent(modPath, gameRelease, strings);
        }
    }

    // The registered plugins are counted exactly as indexed ones are, so a warm launch's
    // progress reaches the whole load order rather than only the plugins it had to index.
    [Fact]
    public void AWarmLoad_CountsEveryRegisteredPluginAsProgress()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-progress")
            .WithPlugin("A.esp").WithPlugin("B.esp").WithPlugin("C.esp")
            .Build();
        using (var cold = MakeManager(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        using var warm = MakeManager(holder);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(3, warm.Status.TotalPlugins);
        Assert.Equal(
            new[] { "A.esp", "B.esp", "C.esp" },
            warm.Status.IndexedPlugins.Select(p => p.Name).ToArray());
    }

    // Validity is by content: the one plugin whose bytes moved is re-indexed, and its
    // neighbours are registered untouched.
    [Fact]
    public void APluginChangedBetweenLoads_IsTheOnlyOneReindexed()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-changed")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = MakeManager(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var edited = new Fallout4Mod(ModKey.FromFileName("B.esp"), Fallout4Release.Fallout4);
        edited.Npcs.AddNew("NpcBEdited");
        edited.WriteToBinary(Path.Combine(data.DataFolder, "B.esp"));

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var warm = MakeManager(holder, loggerFactory);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(1, Registered(entries, "A.esp"));
        Assert.Equal(0, Indexed(entries, "A.esp"));
        Assert.Equal(1, Indexed(entries, "B.esp"));
        Assert.Equal(0, Registered(entries, "B.esp"));

        // And the re-index is what the load order serves: the edited record, not the stale one.
        var documents = warm.RequireReads().GetDocuments(new PluginCopyKey("B.esp", PluginOrigin.DataDirectory));
        Assert.Contains(documents, d => d.EditorId == "NpcBEdited");
        Assert.DoesNotContain(documents, d => d.EditorId == "NpcB");
    }

    // A plugin the index has never seen is indexed on the warm load beside the registered ones —
    // "only what the file has never seen" read from the other side, and the profile-switch shape.
    [Fact]
    public void APluginTheIndexHasNeverSeen_IsIndexedBesideTheRegisteredOnes()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("warm-new")
            .WithPlugin("A.esp")
            .WithPlugin("B.esp", listed: false)
            .Build();
        using (var cold = MakeManager(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        // The profile switch: the same order plus one plugin the index has never been shown.
        var withB = data.Plugins.Append(new LoadOrderEntry("B.esp", Path.Combine(data.DataFolder, "B.esp"), PluginOrigin.DataDirectory, Slot: 99, Enabled: true, Winning: true)).ToList();

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var warm = MakeManager(holder, loggerFactory);
        warm.Reconcile(holder, data.DataFolder, withB, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(1, Registered(entries, "A.esp"));
        Assert.Equal(1, Indexed(entries, "B.esp"));
        Assert.Equal(LoadOrderState.Ready, warm.Status.State);
    }

    // A tracked plugin's truth is its source tree (ADR-0007/0042), so persistence must never override
    // the working tree. ADR-0015 invariant 4: the load validates by content, so an unmoved tree costs
    // a register and a comparison.
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

        // Loaded twice after tracking, so both loads see a tracked plugin whose binary the index
        // already holds a current hash for.
        string npcSourceFile;
        using (var second = MakeManager(holder))
        {
            second.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4, fixture.InstanceRoot);
            npcSourceFile = entry.SourceFileOf(
                second.RequireReads().GetDocuments(entry.KeyOf()).Single(d => d.EditorId == "TrackedNpc"));
        }

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var third = MakeManager(holder, loggerFactory);
        third.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4, fixture.InstanceRoot);

        // An unmoved tree: registered and validated, never re-derived.
        Assert.Equal(1, Registered(entries, plugin));
        Assert.Equal(0, Indexed(entries, plugin));
        Assert.Empty(third.Status.Failures);

        // And the working tree still wins: an edit made between loads is in the load order's
        // answer, which is the whole point of validating rather than trusting the stored rows.
        var text = await File.ReadAllTextAsync(npcSourceFile);
        await File.WriteAllTextAsync(
            npcSourceFile, text.Replace("\"TrackedNpc\"", "\"EditedBetweenLoads\"", StringComparison.Ordinal));
        using var fourth = MakeManager(holder);
        fourth.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4, fixture.InstanceRoot);
        Assert.Contains(
            fourth.RequireReads().GetDocuments(entry.KeyOf()), d => d.EditorId == "EditedBetweenLoads");
    }
}
