using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Plugins;

[Collection(TestPluginFixtureCollection.Name)]
public class LoadOrderMirrorTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static LoadOrderMirror MakeManager(IModImporter? modImporter = null)
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        return new LoadOrderMirror(factory,
            modImporter: modImporter);
    }

    // An explicit request for a release this build doesn't carry the Mutagen assembly for
    // (SkyrimSE, genuinely unreferenced here — see SchemaReflectorAvailabilityTests) must refuse
    // with a typed, actionable exception rather than a raw FileNotFoundException surfacing from
    // deep inside DuckDbRecordIndex.Initialize. The FO4 fixture's data is irrelevant: the throw
    // happens in IndexAndStore before any plugin is opened.
    [Fact]
    public void Load_ForUnsupportedGameRelease_ThrowsUnsupportedGameReleaseException()
    {
        using var manager = MakeManager();

        var ex = Assert.Throws<UnsupportedGameReleaseException>(
            () => manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.SkyrimSE));

        Assert.Contains("SkyrimSE", ex.Message);
    }

    // Distinct from Load_ForUnsupportedGameRelease above, which fails *before* IndexAndStore
    // publishes. Faulting UpdateWinners fails *after* publish, inside IndexAndStore's own catch
    // (DisposeCurrent) — and with nothing after this call touching state (no follow-up
    // Load/Unload), the assertions below observe that catch's own cleanup rather than a later call's
    // masking it, which is exactly what the existing gated tests (UnloadMidLoad_..., ASecondLoadMidLoad_...)
    // could not isolate.
    [Fact]
    public void Reconcile_WhenUpdateWinnersFaults_LeavesWhatLandedHeldAndUnsettled()
    {
        var data = new PluginFixtureBuilder("solo-mid-load-failure")
            .WithPlugin("Base.esp")
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            var faulting = new FaultingUpdateWinnersRepositoryFactory(inner);
            using var manager = new LoadOrderMirror(faulting);

            Assert.Throws<InvalidOperationException>(() =>
                manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4));

            // ADR-0044: nothing is torn down — what landed stays held, honestly reported as not
            // yet settled, for the next snapshot to finish.
            Assert.NotNull(manager.LoadOrder);
            Assert.NotNull(manager.Reads);
            Assert.Equal(LoadOrderState.Reconciling, manager.Status.State);
            Assert.False(manager.Status.ConflictsComputed);
        }
    }

    [Fact]
    public void Load_DelegatesToFactory()
    {
        var reflector = SharedSchemaReflector.Instance;
        var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        var spy = new SpyRepositoryFactory(inner);
        using var manager = new LoadOrderMirror(spy);

        manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.Equal(1, spy.CreateCallCount);
        Assert.Equal(GameRelease.Fallout4, spy.LastGameRelease);
    }

    [Fact]
    public void Load_PopulatesLoadOrderAndRepository()
    {
        using var manager = MakeManager();
        manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.NotNull(manager.LoadOrder);
        Assert.NotNull(manager.Reads);
        Assert.Single(manager.LoadOrder.Plugins);
        Assert.Equal(TestPluginFixture.PluginName, manager.LoadOrder.Plugins[0].Name);
    }

    [Fact]
    public void Load_IndexesRecordsIntoRepository()
    {
        using var manager = MakeManager();
        manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        var count = manager.Reads!.GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0;

        Assert.Equal(TestPluginFixture.RecordCount, count);
    }

    [Fact]
    public void Load_SetsIsWinnerOnSinglePlugin()
    {
        using var manager = MakeManager();
        manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        var result = manager.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 100, Offset: 0));

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.True(r.IsWinner));
    }

    [Fact]
    public void Unload_ClearsReferencesAndDisposesRepository()
    {
        using var manager = MakeManager();
        manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var oldRepo = manager.Reads;
        manager.Close();

        Assert.Null(manager.LoadOrder);
        Assert.Null(manager.Reads);
        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data")));
    }

    [Fact]
    public void Reconcile_SameInstance_KeepsTheRepositoryAndLoadOrder()
    {
        using var manager = MakeManager();
        manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var firstRepo = manager.Reads;
        var firstLoadOrder = manager.LoadOrder;

        manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        // ADR-0044: a snapshot for the same instance reconciles in place — nothing is replaced.
        Assert.Same(firstRepo, manager.Reads);
        Assert.Same(firstLoadOrder, manager.LoadOrder);
    }

    [Fact]
    public void Load_WithGameRelease_LoadOrderHasCorrectGameRelease()
    {
        using var manager = MakeManager();
        manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.Equal(GameRelease.Fallout4, manager.LoadOrder!.GameRelease);
    }




    // --- CreatePlugin ---
    //
    // ADR-0041: the destination is a caller-resolved (path, origin) — a mod folder or
    // overwrite/, never implicitly the game's Data folder — and CreatePlugin never touches
    // plugins.txt (that append is the caller's job: the extension's Mod Management
    // writer, or a script/agent's own per ADR-0024).

    [Fact]
    public void CreatePlugin_UpdatesHeldState()
    {
        var data = new PluginFixtureBuilder("cp-state")
            .WithPlugin("Base.esp", mod => mod.Npcs.AddNew("ExistingNPC"))
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var repositoryBefore = manager.Reads;
            var modFolder = Path.Combine(data.DataFolder, "SomeMod");

            var result = manager.CreatePlugin("NewPlugin.esp", modFolder, "SomeMod");

            Assert.Same(repositoryBefore, manager.Reads);
            Assert.Equal("SomeMod", result.Origin);
            Assert.Contains(manager.LoadOrder!.Plugins, p => p.Name == "NewPlugin.esp" && p.Origin == "SomeMod");
            Assert.Equal(1, manager.Reads!.GetRecordTypeCounts(new PluginKey("Base.esp", "Data"))
                .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        }
    }

    // #290: a newly created plugin defaults to an ESL-flagged ESP, silently — no creation prompt;
    // the flag is an ordinary editable header field afterward. Asserted at the binary, where the
    // game reads it.
    [Fact]
    public void CreatePlugin_DefaultsToAnEslFlaggedEsp()
    {
        var data = new PluginFixtureBuilder("cp-esl")
            .WithPlugin("Base.esp", mod => mod.Npcs.AddNew("ExistingNPC"))
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var modFolder = Path.Combine(data.DataFolder, "SomeMod");

            manager.CreatePlugin("NewPlugin.esp", modFolder, "SomeMod");

            using var written = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(
                new Mutagen.Bethesda.Plugins.ModPath(
                    Mutagen.Bethesda.Plugins.ModKey.FromFileName("NewPlugin.esp"),
                    Path.Combine(modFolder, "NewPlugin.esp")),
                GameRelease.Fallout4);
            Assert.True(((Mutagen.Bethesda.Plugins.Records.IModFlagsGetter)written).IsSmallMaster);
        }
    }

    // plugins.txt is Mod Management's file (CONTEXT-MAP.md); appending the load-order line is the
    // caller's job, done only once the whole create (and any Track it triggers) has succeeded.
    // This side never reads a plugins.txt either, so the assertion is that no such file is brought
    // into existence at all.
    [Fact]
    public void CreatePlugin_NeverWritesPluginsTxt()
    {
        var data = new PluginFixtureBuilder("cp-no-pluginstxt")
            .WithPlugin("Base.esp")
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var modFolder = Path.Combine(data.DataFolder, "SomeMod");

            manager.CreatePlugin("NewPlugin.esp", modFolder, "SomeMod");

            Assert.Empty(Directory.EnumerateFiles(data.CleanupRoot, "Plugins.txt", SearchOption.AllDirectories));
        }
    }

    // --- SetFilter / ClearFilter ---

    [Fact]
    public void SetFilter_NoLoadOrder_ThrowsInvalidOperationException()
    {
        using var manager = MakeManager();
        var ex = Assert.Throws<NoLoadOrderException>(() => manager.SetFilter("SELECT form_key FROM \"NPC_\""));
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void ClearFilter_NoLoadOrder_ThrowsInvalidOperationException()
    {
        using var manager = MakeManager();
        var ex = Assert.Throws<NoLoadOrderException>(() => manager.ClearFilter());
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void SetFilter_ValidSql_SetsSqlOnLoadOrder()
    {
        using var manager = MakeLoadedManager();
        manager.SetFilter("SELECT form_key FROM \"NPC_\"");
        Assert.Equal("SELECT form_key FROM \"NPC_\"", manager.LoadOrder!.FilterSql);
    }

    [Fact]
    public void ClearFilter_AfterSetFilter_ClearsSqlOnLoadOrder()
    {
        using var manager = MakeLoadedManager();
        manager.SetFilter("SELECT form_key FROM \"NPC_\"");
        manager.ClearFilter();
        Assert.Null(manager.LoadOrder!.FilterSql);
    }

    // --- Filter re-materialization ---
    //
    // _filter is a one-shot snapshot (SetFilter's CREATE OR REPLACE TABLE) of whatever matched the
    // filter SQL at the moment it ran. Nothing else keeps it in step, so every mutation path that can
    // change which records match has to re-run it — these pin the LoadOrderMirror-side call sites.

    [Fact]
    public async Task ReindexPlugin_AfterBinaryChangeMakesARecordNewlyMatchTheFilter_FilteredListingIncludesIt()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("reindex-filter-newly-matches")
            .WithPlugin("Plugin.esp", mod => npcKey = mod.Npcs.AddNew("NotMatchingYet").FormKey)
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);

            manager.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'NowMatches'");
            Assert.Equal(0, manager.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            var pluginPath = Path.Combine(data.DataFolder, "Plugin.esp");
            var onDisk = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName("Plugin.esp"), pluginPath), Fallout4Release.Fallout4);
            onDisk.Npcs.First(n => n.FormKey == npcKey).EditorID = "NowMatches";
            onDisk.WriteToBinary(pluginPath);

            var pluginKey = new PluginKey("Plugin.esp", data.Plugins.Single(p => p.Name == "Plugin.esp").Origin);
            await manager.ReindexPlugin(pluginKey);

            var result = manager.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(1, result.Total);
            Assert.Equal(npcKey.ToString(), result.Items[0].FormKey);
        }
    }

    [Fact]
    public async Task ReindexPlugin_AfterBinaryChangeMakesARecordStopMatchingTheFilter_FilteredListingExcludesIt()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("reindex-filter-stops-matching")
            .WithPlugin("Plugin.esp", mod => npcKey = mod.Npcs.AddNew("StillMatches").FormKey)
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);

            manager.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'StillMatches'");
            Assert.Equal(1, manager.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            var pluginPath = Path.Combine(data.DataFolder, "Plugin.esp");
            var onDisk = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName("Plugin.esp"), pluginPath), Fallout4Release.Fallout4);
            onDisk.Npcs.First(n => n.FormKey == npcKey).EditorID = "NoLongerMatches";
            onDisk.WriteToBinary(pluginPath);

            var pluginKey = new PluginKey("Plugin.esp", data.Plugins.Single(p => p.Name == "Plugin.esp").Origin);
            await manager.ReindexPlugin(pluginKey);

            var result = manager.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(0, result.Total);
        }
    }


    [Fact]
    public async Task ReindexPlugin_WhenReapplyingTheFilterFaults_DoesNotThrow_AndLogsAWarningNamingTheException()
    {
        var data = new PluginFixtureBuilder("reindex-filter-fault")
            .WithPlugin("Plugin.esp", mod => mod.Npcs.AddNew("Npc"))
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            var faulting = new FaultingSetFilterRepositoryFactory(inner);
            var entries = new List<LogEntry>();
            using var loggerFactory = LoggerFactory.Create(b =>
            {
                b.SetMinimumLevel(LogLevel.Debug);
                b.AddProvider(new CollectingLoggerProvider(entries));
            });
            using var manager = new LoadOrderMirror(faulting, loggerFactory.CreateLogger<LoadOrderMirror>());

            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            manager.SetFilter("SELECT form_key FROM npc_");
            faulting.FaultNextCall = true;

            var pluginKey = new PluginKey("Plugin.esp", data.Plugins.Single(p => p.Name == "Plugin.esp").Origin);
            var ex = await Record.ExceptionAsync(() => manager.ReindexPlugin(pluginKey));

            Assert.Null(ex);
            Assert.Contains(entries, e =>
                e.Level == LogLevel.Warning && e.Message.Contains("simulated re-materialization fault", StringComparison.Ordinal));
        }
    }

    // --- helpers ---

    private sealed class SpyRepositoryFactory(IRecordIndexFactory inner) : IRecordIndexFactory
    {
        private readonly IRecordIndexFactory _inner = inner;
        public int CreateCallCount { get; private set; }
        public GameRelease? LastGameRelease { get; private set; }

        public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null)
        {
            CreateCallCount++;
            LastGameRelease = gameRelease;
            return _inner.Create(gameRelease);
        }
    }

    // A real DuckDbRecordIndex wrapped through DelegatingRecordIndex (TestSupport) with one member
    // intercepted — real DuckDB behaviour everywhere except the one call this test needs to fault.
    private sealed class FaultingSetFilterRepositoryFactory(IRecordIndexFactory inner) : IRecordIndexFactory
    {
        public bool FaultNextCall;

        public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null) =>
            new FaultingSetFilterRepository(inner.Create(gameRelease, instanceRoot), this);
    }

    private sealed class FaultingSetFilterRepository(IRecordIndex inner, FaultingSetFilterRepositoryFactory owner)
        : DelegatingRecordIndex(inner)
    {
        public override void SetFilter(string? sql)
        {
            if (owner.FaultNextCall)
            {
                owner.FaultNextCall = false;
                throw new FakeDbFault("simulated re-materialization fault");
            }
            base.SetFilter(sql);
        }
    }

    // DuckDBException itself (DuckDB.NET.Data) is the real type SetFilter's SQL execution actually
    // throws, but every one of its constructors is internal to that assembly — this is the smallest
    // concrete DbException the catch clause can be proven against from outside it. The catch is typed
    // on the DbException base, so which concrete subtype arrives is not the thing under test here.
    private sealed class FakeDbFault(string message) : System.Data.Common.DbException(message);

    // UpdateWinners runs once, after IndexProgressively's per-plugin loop — faulting it fails
    // the load synchronously, on the calling thread, after publish, with no gate/thread coordination
    // needed to isolate IndexAndStore's own catch (DisposeCurrent) from a later call's cleanup.
    private sealed class FaultingUpdateWinnersRepositoryFactory(IRecordIndexFactory inner) : IRecordIndexFactory
    {
        public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null) =>
            new FaultingUpdateWinnersRepository(inner.Create(gameRelease, instanceRoot));
    }

    private sealed class FaultingUpdateWinnersRepository(IRecordIndex inner) : DelegatingRecordIndex(inner)
    {
        public override void UpdateWinners() => throw new InvalidOperationException("simulated mid-load winner-sweep fault");
    }



    [Fact]
    public void CreatePlugin_NoLoadOrder_ThrowsInvalidOperationException()
    {
        using var manager = MakeManager(); // not loaded
        var ex = Assert.Throws<NoLoadOrderException>(() => manager.CreatePlugin("New.esp", "/tmp/SomeMod", "SomeMod"));
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void CreatePlugin_AlreadyExists_ThrowsIOException()
    {
        var data = new PluginFixtureBuilder("cp-already-exists")
            .WithPlugin("Base.esp")
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var modFolder = Path.Combine(data.DataFolder, "SomeMod");
            manager.CreatePlugin("Duplicate.esp", modFolder, "SomeMod"); // first call creates it
            var ex = Assert.Throws<IOException>(() => manager.CreatePlugin("Duplicate.esp", modFolder, "SomeMod"));
            Assert.Contains("already exists", ex.Message);
        }
    }

    // --- CreatePlugin guard clauses ---

    [Fact]
    public void CreatePlugin_InvalidExtension_ThrowsArgumentException()
    {
        using var manager = MakeManager(); // no Load — extension check fires first
        var ex = Assert.Throws<ArgumentException>(() => manager.CreatePlugin("Mod.txt", "/tmp/SomeMod", "SomeMod"));
        Assert.Contains("extension", ex.Message);
    }

    [Fact]
    public void CreatePlugin_NullName_ThrowsArgumentException()
    {
        using var manager = MakeLoadedManager();
        var ex = Assert.Throws<ArgumentException>(() => manager.CreatePlugin(null!, "/tmp/SomeMod", "SomeMod"));
        Assert.Contains("empty", ex.Message);
    }

    [Fact]
    public void CreatePlugin_WhitespaceName_ThrowsArgumentException()
    {
        using var manager = MakeLoadedManager();
        var ex = Assert.Throws<ArgumentException>(() => manager.CreatePlugin("   ", "/tmp/SomeMod", "SomeMod"));
        Assert.Contains("empty", ex.Message);
    }

    [Fact]
    public void CreatePlugin_WhitespacePath_ThrowsArgumentException()
    {
        using var manager = MakeLoadedManager();
        var ex = Assert.Throws<ArgumentException>(() => manager.CreatePlugin("New.esp", "   ", "SomeMod"));
        Assert.Contains("empty", ex.Message);
    }

    [Fact]
    public void CreatePlugin_WhitespaceOrigin_ThrowsArgumentException()
    {
        using var manager = MakeLoadedManager();
        var ex = Assert.Throws<ArgumentException>(() => manager.CreatePlugin("New.esp", "/tmp/SomeMod", "   "));
        Assert.Contains("empty", ex.Message);
    }

    [Fact]
    public void CreatePlugin_EsmExtension_IsAccepted()
    {
        var data = new PluginFixtureBuilder("cp-esm").WithPlugin("Base.esp").Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);

            var result = manager.CreatePlugin("NewMaster.esm", Path.Combine(data.DataFolder, "SomeMod"), "SomeMod");

            Assert.Equal("NewMaster.esm", result.Name);
            Assert.True(result.IsMaster);
        }
    }

    [Fact]
    public void CreatePlugin_EslExtension_IsAccepted()
    {
        var data = new PluginFixtureBuilder("cp-esl").WithPlugin("Base.esp").Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);

            var result = manager.CreatePlugin("NewLight.esl", Path.Combine(data.DataFolder, "SomeMod"), "SomeMod");

            Assert.Equal("NewLight.esl", result.Name);
            Assert.True(result.IsLight);
        }
    }

    [Fact]
    public void CreatePlugin_DestinationFolderDoesNotExistYet_CreatesIt()
    {
        var data = new PluginFixtureBuilder("cp-new-folder").WithPlugin("Base.esp").Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var modFolder = Path.Combine(data.DataFolder, "BrandNewMod");
            Assert.False(Directory.Exists(modFolder));

            manager.CreatePlugin("New.esp", modFolder, "BrandNewMod");

            Assert.True(File.Exists(Path.Combine(modFolder, "New.esp")));
        }
    }

    // --- Disposal actually releases resources ---

    [Fact]
    public void Reconcile_ForADifferentInstance_OldRepositoryBecomesUnusable()
    {
        using var manager = MakeManager();
        manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var oldRepo = manager.Reads;

        // ADR-0044: only a snapshot for another instance replaces what is held; the same instance
        // reconciles in place (Reconcile_SameInstance_KeepsTheRepositoryAndLoadOrder).
        var otherInstance = Directory.CreateDirectory(Path.Combine(_fixture.InstanceRoot, "other-instance")).FullName;
        manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, otherInstance);

        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data")));
    }


    [Fact]
    public void Dispose_RepositoryBecomesUnusable()
    {
        var manager = MakeManager();
        manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var oldRepo = manager.Reads;

        manager.Dispose();

        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data")));
    }





    // --- Load disposes previous load order ---

    // --- helpers ---

    private LoadOrderMirror MakeLoadedManager()
    {
        var m = MakeManager();
        m.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        return m;
    }

    private sealed class SpyModImporter : IModImporter
    {
        private readonly List<SpyLoadedMod> _mods = [];
        public IReadOnlyList<SpyLoadedMod> LoadedMods => _mods;

        public ILoadedMod Import(ModPath modPath, GameRelease gameRelease, BinaryReadParameters? param = null)
        {
            var real = ModFactory.ImportGetter(modPath, gameRelease, param);
            var spy = new SpyLoadedMod(real);
            _mods.Add(spy);
            return spy;
        }
    }

    private sealed class SpyLoadedMod(IModDisposeGetter inner) : ILoadedMod
    {
        public bool IsDisposed { get; private set; }
        public IModGetter Getter => inner;
        public void Dispose() { IsDisposed = true; inner.Dispose(); }
    }
}
