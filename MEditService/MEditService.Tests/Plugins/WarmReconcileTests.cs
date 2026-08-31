using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Plugins;

// ADR-0001: loading a load order the index has already seen *registers* its plugins rather than
// indexing them. Every test here loads twice over one persistent index — the second manager stands
// in for the next launch — and asserts what the second load did through the load order's own status
// and its existing per-plugin log lines, never by looking inside the index file.
public sealed class WarmReconcileTests
{
    private static LoadOrderMirror MakeManager(ILogger<LoadOrderMirror>? logger = null)
    {
        var reflector = SharedSchemaReflector.Instance;
        return new LoadOrderMirror(new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)), logger);
    }

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
        using var data = new PluginFixtureBuilder("warm-same")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = MakeManager()) cold.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var warm = MakeManager(loggerFactory.CreateLogger<LoadOrderMirror>());
        warm.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(0, Indexed(entries, "A.esp"));
        Assert.Equal(0, Indexed(entries, "B.esp"));
        Assert.Equal(1, Registered(entries, "A.esp"));
        Assert.Equal(1, Registered(entries, "B.esp"));

        Assert.Equal(LoadOrderState.Ready, warm.Status.State);
        Assert.True(warm.Status.ConflictsComputed);
        Assert.NotEmpty(warm.Index!.GetDocuments(new PluginKey("A.esp", PluginOrigin.DataDirectory)));
    }

    // The "during" half of progress: observed from inside the load loop itself, once per
    // plugin as it is registered. A load that only published its count at the end would satisfy the
    // final-state assertion below and still leave a warm launch sitting at zero.
    [Fact]
    public void AWarmLoad_AdvancesProgressAsEachPluginIsRegistered()
    {
        using var data = new PluginFixtureBuilder("warm-during")
            .WithPlugin("A.esp").WithPlugin("B.esp").WithPlugin("C.esp")
            .Build();
        using (var cold = MakeManager()) cold.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var reflector = SharedSchemaReflector.Instance;
        var observed = new List<int>();
        var factory = new ProgressWatchingFactory(
            new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)), observed);
        using var warm = new LoadOrderMirror(factory);
        factory.Mirror = warm;

        warm.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        // Each registration saw the plugins that had already landed and no more.
        Assert.Equal([0, 1, 2], observed);
    }

    // Every registration is asked, as it happens, how much progress the load order was reporting at
    // that moment.
    private sealed class ProgressWatchingFactory(IRecordIndexFactory inner, List<int> observed) : IRecordIndexFactory
    {
        public LoadOrderMirror? Mirror { get; set; }

        public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null) =>
            new ProgressWatchingIndex(inner.Create(gameRelease, instanceRoot), this, observed);
    }

    private sealed class ProgressWatchingIndex(IRecordIndex inner, ProgressWatchingFactory owner, List<int> observed)
        : DelegatingRecordIndex(inner)
    {
        public override void Register(PluginKey key, Registration registration)
        {
            observed.Add(owner.Mirror!.Status.IndexedPlugins.Count);
            base.Register(key, registration);
        }
    }

    // The registered plugins are counted exactly as indexed ones are, so a warm launch's
    // progress reaches the whole load order rather than only the plugins it had to index.
    [Fact]
    public void AWarmLoad_CountsEveryRegisteredPluginAsProgress()
    {
        using var data = new PluginFixtureBuilder("warm-progress")
            .WithPlugin("A.esp").WithPlugin("B.esp").WithPlugin("C.esp")
            .Build();
        using (var cold = MakeManager()) cold.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        using var warm = MakeManager();
        warm.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

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
        using var data = new PluginFixtureBuilder("warm-changed")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = MakeManager()) cold.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var edited = new Fallout4Mod(ModKey.FromFileName("B.esp"), Fallout4Release.Fallout4);
        edited.Npcs.AddNew("NpcBEdited");
        edited.WriteToBinary(Path.Combine(data.DataFolder, "B.esp"));

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var warm = MakeManager(loggerFactory.CreateLogger<LoadOrderMirror>());
        warm.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(1, Registered(entries, "A.esp"));
        Assert.Equal(0, Indexed(entries, "A.esp"));
        Assert.Equal(1, Indexed(entries, "B.esp"));
        Assert.Equal(0, Registered(entries, "B.esp"));

        // And the re-index is what the load order serves: the edited record, not the stale one.
        var documents = warm.Index!.GetDocuments(new PluginKey("B.esp", PluginOrigin.DataDirectory));
        Assert.Contains(documents, d => d.EditorId == "NpcBEdited");
        Assert.DoesNotContain(documents, d => d.EditorId == "NpcB");
    }

    // A plugin the index has never seen is indexed on the warm load beside the registered ones —
    // "only what the file has never seen" read from the other side, and the profile-switch shape.
    [Fact]
    public void APluginTheIndexHasNeverSeen_IsIndexedBesideTheRegisteredOnes()
    {
        using var data = new PluginFixtureBuilder("warm-new")
            .WithPlugin("A.esp")
            .WithPlugin("B.esp", listed: false)
            .Build();
        using (var cold = MakeManager()) cold.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        // The profile switch: the same order plus one plugin the index has never been shown.
        var withB = data.Plugins.Append(new LoadOrderEntry("B.esp", Path.Combine(data.DataFolder, "B.esp"), PluginOrigin.DataDirectory, Slot: 99, Enabled: true, Winning: true)).ToList();

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var warm = MakeManager(loggerFactory.CreateLogger<LoadOrderMirror>());
        warm.Reconcile(data.DataFolder, withB, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(1, Registered(entries, "A.esp"));
        Assert.Equal(1, Indexed(entries, "B.esp"));
        Assert.Equal(LoadOrderState.Ready, warm.Status.State);
    }

    // A tracked plugin's truth is its source tree (ADR-0041/0042), so it is re-ingested on
    // every load however current its binary — persistence must never override the working tree.
    [Fact]
    public async Task ATrackedPlugin_IsReingestedFromSourceOnEveryLoad()
    {
        const string origin = "TrackedMod";
        const string plugin = "Tracked.esp";
        var instanceRoot = Directory.CreateTempSubdirectory("medit-warm-instance-").FullName;
        var modFolder = Directory.CreateDirectory(Path.Combine(instanceRoot, "mods", origin)).FullName;
        var gameDirectory = Directory.CreateTempSubdirectory("medit-warm-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, plugin);
            var mod = new Fallout4Mod(ModKey.FromFileName(plugin), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("TrackedNpc");
            mod.WriteToBinary(pluginPath);

            List<LoadOrderEntry> order = [new(plugin, pluginPath, origin, Slot: 0, Enabled: true, Winning: true)];

            using (var cold = MakeManager())
            {
                cold.Reconcile(gameDirectory, order, GameRelease.Fallout4, instanceRoot);
                await new TrackService(NullLogger<TrackService>.Instance)
                    .TrackAsync(cold.LoadOrder!, origin, SourcePreset.Edits);
            }

            // Loaded twice *after* tracking, so both loads see a tracked plugin whose binary the
            // index already holds a current hash for — the exact state a register would wrongly
            // shortcut.
            using (var second = MakeManager()) second.Reconcile(gameDirectory, order, GameRelease.Fallout4, instanceRoot);

            var (loggerFactory, entries) = Capturing();
            using var _ = loggerFactory;
            using var third = MakeManager(loggerFactory.CreateLogger<LoadOrderMirror>());
            third.Reconcile(gameDirectory, order, GameRelease.Fallout4, instanceRoot);

            Assert.Equal(0, Registered(entries, plugin));
            Assert.Equal(1, Indexed(entries, plugin));
            Assert.Contains(entries, e => e.Message.Contains("from its source tree", StringComparison.Ordinal));
            Assert.Empty(third.LoadOrder!.LoadFailures);
        }
        finally
        {
            Directory.Delete(instanceRoot, recursive: true);
            Directory.Delete(gameDirectory, recursive: true);
        }
    }
}
