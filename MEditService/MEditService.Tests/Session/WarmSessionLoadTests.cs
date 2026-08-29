using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Session;

// #586 / ADR-0001: loading a session the index has already seen *registers* its plugins rather than
// indexing them. Every test here loads twice over one persistent index — the second manager stands
// in for the next launch — and asserts what the second load did through the session's own status
// and its existing per-plugin log lines, never by looking inside the index file.
public sealed class WarmSessionLoadTests : IDisposable
{
    private readonly string _indexRoot = Path.Combine(Path.GetTempPath(), $"medit-warm-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_indexRoot)) Directory.Delete(_indexRoot, recursive: true);
    }

    private SessionManager MakeManager(ILogger<SessionManager>? logger = null)
    {
        var reflector = SharedSchemaReflector.Instance;
        return new SessionManager(
            new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector), null, _indexRoot), logger);
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

    // AC1. The whole ticket: a warm launch pays for no indexing at all, and still arrives at a fully
    // loaded session — Ready, winners swept, records answering.
    [Fact]
    public void ASecondLoadOfTheSameOrder_IndexesNothing_AndIsStillReadyWithWinners()
    {
        using var data = new PluginFixtureBuilder("warm-same")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = MakeManager()) cold.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var warm = MakeManager(loggerFactory.CreateLogger<SessionManager>());
        warm.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        Assert.Equal(0, Indexed(entries, "A.esp"));
        Assert.Equal(0, Indexed(entries, "B.esp"));
        Assert.Equal(1, Registered(entries, "A.esp"));
        Assert.Equal(1, Registered(entries, "B.esp"));

        Assert.Equal(SessionState.Ready, warm.Status.State);
        Assert.True(warm.Status.ConflictsComputed);
        Assert.NotEmpty(warm.Index!.GetDocuments(new PluginKey("A.esp", PluginOrigin.DataDirectory)));
    }

    // AC4. The registered plugins are counted exactly as indexed ones are, so a warm launch's
    // progress advances per plugin instead of sitting at zero until the sweep.
    [Fact]
    public void AWarmLoad_CountsEveryRegisteredPluginAsProgress()
    {
        using var data = new PluginFixtureBuilder("warm-progress")
            .WithPlugin("A.esp").WithPlugin("B.esp").WithPlugin("C.esp")
            .Build();
        using (var cold = MakeManager()) cold.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        using var warm = MakeManager();
        warm.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        Assert.Equal(3, warm.Status.TotalPlugins);
        Assert.Equal(
            new[] { "A.esp", "B.esp", "C.esp" },
            warm.Status.IndexedPlugins.Select(p => p.Name).ToArray());
    }

    // AC2. Validity is by content: the one plugin whose bytes moved is re-indexed, and its
    // neighbours are registered untouched.
    [Fact]
    public void APluginChangedBetweenLoads_IsTheOnlyOneReindexed()
    {
        using var data = new PluginFixtureBuilder("warm-changed")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        using (var cold = MakeManager()) cold.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        var edited = new Fallout4Mod(ModKey.FromFileName("B.esp"), Fallout4Release.Fallout4);
        edited.Npcs.AddNew("NpcBEdited");
        edited.WriteToBinary(Path.Combine(data.DataFolder, "B.esp"));

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var warm = MakeManager(loggerFactory.CreateLogger<SessionManager>());
        warm.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        Assert.Equal(1, Registered(entries, "A.esp"));
        Assert.Equal(0, Indexed(entries, "A.esp"));
        Assert.Equal(1, Indexed(entries, "B.esp"));
        Assert.Equal(0, Registered(entries, "B.esp"));

        // And the re-index is what the session serves: the edited record, not the stale one.
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
        using (var cold = MakeManager()) cold.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        File.WriteAllText(data.PluginsTxtPath, "*A.esp\n*B.esp\n");

        var (loggerFactory, entries) = Capturing();
        using var _ = loggerFactory;
        using var warm = MakeManager(loggerFactory.CreateLogger<SessionManager>());
        warm.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        Assert.Equal(1, Registered(entries, "A.esp"));
        Assert.Equal(1, Indexed(entries, "B.esp"));
        Assert.Equal(SessionState.Ready, warm.Status.State);
    }

    // AC3. A tracked plugin's truth is its source tree (ADR-0041/0042), so it is re-ingested on
    // every load however current its binary — persistence must never override the working tree.
    [Fact]
    public async Task ATrackedPlugin_IsReingestedFromSourceOnEveryLoad()
    {
        const string origin = "TrackedMod";
        const string plugin = "Tracked.esp";
        var modFolder = Directory.CreateTempSubdirectory("medit-warm-tracked-").FullName;
        var gameDirectory = Directory.CreateTempSubdirectory("medit-warm-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, plugin);
            var mod = new Fallout4Mod(ModKey.FromFileName(plugin), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("TrackedNpc");
            mod.WriteToBinary(pluginPath);

            List<ExplicitPluginInput> order = [new(plugin, pluginPath, origin, true)];

            using (var cold = MakeManager())
            {
                cold.LoadExplicit(gameDirectory, order, GameRelease.Fallout4);
                await new TrackService(NullLogger<TrackService>.Instance)
                    .TrackAsync(cold.Session!, origin, SourcePreset.Edits);
            }

            // Loaded twice *after* tracking, so both loads see a tracked plugin whose binary the
            // index already holds a current hash for — the exact state a register would wrongly
            // shortcut.
            using (var second = MakeManager()) second.LoadExplicit(gameDirectory, order, GameRelease.Fallout4);

            var (loggerFactory, entries) = Capturing();
            using var _ = loggerFactory;
            using var third = MakeManager(loggerFactory.CreateLogger<SessionManager>());
            third.LoadExplicit(gameDirectory, order, GameRelease.Fallout4);

            Assert.Equal(0, Registered(entries, plugin));
            Assert.Equal(1, Indexed(entries, plugin));
            Assert.Contains(entries, e => e.Message.Contains("from its source tree", StringComparison.Ordinal));
            Assert.Empty(third.Session!.LoadFailures);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDirectory, recursive: true);
        }
    }
}
