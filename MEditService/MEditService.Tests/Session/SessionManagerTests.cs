using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Session;

[Collection(TestPluginFixtureCollection.Name)]
public class SessionManagerTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static SessionManager MakeManager(IModImporter? modImporter = null)
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        return new SessionManager(factory,
            modImporter: modImporter);
    }

    // #445: an explicit request for a release this build doesn't carry the Mutagen assembly for
    // (SkyrimSE, genuinely unreferenced here — see SchemaReflectorAvailabilityTests) must refuse
    // with a typed, actionable exception rather than a raw FileNotFoundException surfacing from
    // deep inside DuckDbRecordIndex.Initialize. The FO4 fixture's data is irrelevant: the throw
    // happens in IndexAndStore before any plugin is opened.
    [Fact]
    public void Load_ForUnsupportedGameRelease_ThrowsUnsupportedGameReleaseException()
    {
        using var manager = MakeManager();

        var ex = Assert.Throws<UnsupportedGameReleaseException>(
            () => manager.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.SkyrimSE));

        Assert.Contains("SkyrimSE", ex.Message);
    }

    // #400: distinct from Load_ForUnsupportedGameRelease above, which fails *before* IndexAndStore
    // publishes. Faulting UpdateWinners fails *after* publish, inside IndexAndStore's own catch
    // (DisposeCurrentSession) — and with nothing after this call touching state (no follow-up
    // Load/Unload), the assertions below observe that catch's own cleanup rather than a later call's
    // masking it, which is exactly what the existing gated tests (UnloadMidLoad_..., ASecondLoadMidLoad_...)
    // could not isolate.
    [Fact]
    public void Load_WhenUpdateWinnersFaultsMidLoad_LeavesNoSessionBehindImmediately()
    {
        var data = new PluginFixtureBuilder("solo-mid-load-failure")
            .WithPlugin("Base.esp")
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            var faulting = new FaultingUpdateWinnersRepositoryFactory(inner);
            using var manager = new SessionManager(faulting);

            Assert.Throws<InvalidOperationException>(() =>
                manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4));

            Assert.Null(manager.Session);
            Assert.Null(manager.Repository);
            Assert.Equal(SessionState.None, manager.Status.State);
        }
    }

    [Fact]
    public void Load_DelegatesToFactory()
    {
        var reflector = SharedSchemaReflector.Instance;
        var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        var spy = new SpyRepositoryFactory(inner);
        using var manager = new SessionManager(spy);

        manager.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.Equal(1, spy.CreateCallCount);
        Assert.Equal(GameRelease.Fallout4, spy.LastGameRelease);
    }

    [Fact]
    public void Load_PopulatesSessionAndRepository()
    {
        using var manager = MakeManager();
        manager.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.NotNull(manager.Session);
        Assert.NotNull(manager.Repository);
        Assert.Single(manager.Session.Plugins);
        Assert.Equal(TestPluginFixture.PluginName, manager.Session.Plugins[0].Name);
    }

    [Fact]
    public void Load_IndexesRecordsIntoRepository()
    {
        using var manager = MakeManager();
        manager.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        var count = manager.Repository!.GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0;

        Assert.Equal(TestPluginFixture.RecordCount, count);
    }

    [Fact]
    public void Load_SetsIsWinnerOnSinglePlugin()
    {
        using var manager = MakeManager();
        manager.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        var result = manager.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 100, Offset: 0));

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.True(r.IsWinner));
    }

    [Fact]
    public void Unload_ClearsReferencesAndDisposesRepository()
    {
        using var manager = MakeManager();
        manager.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var oldRepo = manager.Repository;
        manager.Unload();

        Assert.Null(manager.Session);
        Assert.Null(manager.Repository);
        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data")));
    }

    [Fact]
    public void Load_ReplacesExistingSession()
    {
        using var manager = MakeManager();
        manager.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var firstRepo = manager.Repository;

        manager.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.NotSame(firstRepo, manager.Repository);
        Assert.NotNull(manager.Session);
    }

    [Fact]
    public void Load_WithGameRelease_SessionHasCorrectGameRelease()
    {
        using var manager = MakeManager();
        manager.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.Equal(GameRelease.Fallout4, manager.Session!.GameRelease);
    }




    // --- CreatePlugin ---
    //
    // #288 / ADR-0041: the destination is now a caller-resolved (path, origin) — a mod folder or
    // overwrite/, never implicitly the game's Data folder — and CreatePlugin never touches
    // plugins.txt any more (that append moved to the caller: the extension's Mod Management
    // writer, or a script/agent's own per ADR-0024).

    [Fact]
    public void CreatePlugin_UpdatesSessionState()
    {
        var data = new PluginFixtureBuilder("cp-state")
            .WithPlugin("Base.esp", mod => mod.Npcs.AddNew("ExistingNPC"))
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var repositoryBefore = manager.Repository;
            var modFolder = Path.Combine(data.DataFolder, "SomeMod");

            var result = manager.CreatePlugin("NewPlugin.esp", modFolder, "SomeMod");

            Assert.Same(repositoryBefore, manager.Repository);
            Assert.Equal("SomeMod", result.Origin);
            Assert.Contains(manager.Session!.Plugins, p => p.Name == "NewPlugin.esp" && p.Origin == "SomeMod");
            Assert.Equal(1, manager.Repository!.GetRecordTypeCounts(new PluginKey("Base.esp", "Data"))
                .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        }
    }

    // The rival this guards against is #288's own starting point: the pre-#288 CreatePlugin
    // unconditionally appended "*<name>\n" to plugins.txt as part of the same call. Applied as a
    // rival (a one-line File.AppendAllText re-added to CreatePlugin), this test fails — observed
    // 2026-08-20, the appended line landing exactly where the assertion below now forbids it.
    // plugins.txt is Mod Management's file (CONTEXT-MAP.md); appending the load-order line is the
    // caller's job, done only once the whole create (and any Track it triggers) has succeeded.
    // Since #592 this side never reads a plugins.txt either, so the assertion is that no such file
    // is brought into existence at all — a stronger statement than the byte comparison it replaces.
    [Fact]
    public void CreatePlugin_NeverWritesPluginsTxt()
    {
        var data = new PluginFixtureBuilder("cp-no-pluginstxt")
            .WithPlugin("Base.esp")
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var modFolder = Path.Combine(data.DataFolder, "SomeMod");

            manager.CreatePlugin("NewPlugin.esp", modFolder, "SomeMod");

            Assert.Empty(Directory.EnumerateFiles(data.CleanupRoot, "Plugins.txt", SearchOption.AllDirectories));
        }
    }

    // --- SetFilter / ClearFilter ---

    [Fact]
    public void SetFilter_NoSession_ThrowsInvalidOperationException()
    {
        using var manager = MakeManager();
        var ex = Assert.Throws<InvalidOperationException>(() => manager.SetFilter("SELECT form_key FROM \"NPC_\""));
        Assert.Contains("No session", ex.Message);
    }

    [Fact]
    public void ClearFilter_NoSession_ThrowsInvalidOperationException()
    {
        using var manager = MakeManager();
        var ex = Assert.Throws<InvalidOperationException>(() => manager.ClearFilter());
        Assert.Contains("No session", ex.Message);
    }

    [Fact]
    public void SetFilter_ValidSql_SetsSqlOnSession()
    {
        using var manager = MakeLoadedManager();
        manager.SetFilter("SELECT form_key FROM \"NPC_\"");
        Assert.Equal("SELECT form_key FROM \"NPC_\"", manager.Session!.FilterSql);
    }

    [Fact]
    public void ClearFilter_AfterSetFilter_ClearsSqlOnSession()
    {
        using var manager = MakeLoadedManager();
        manager.SetFilter("SELECT form_key FROM \"NPC_\"");
        manager.ClearFilter();
        Assert.Null(manager.Session!.FilterSql);
    }

    // #418 closeout: the ReserveFormKey test block (ReserveFormKey_LoadedPlugin_
    // ReturnsValidFormKeyAndIncrements, ReserveFormKey_NoSession_ThrowsInvalidOperationException,
    // ReserveFormKey_UnknownPlugin_ThrowsArgumentException, ReserveFormKey_ConcurrentCalls_
    // ReturnDistinctFormKeys, ReserveFormKey_ExhaustedSpace_ThrowsInvalidOperationException,
    // ReserveFormKey_AtMaxValidFormId_Succeeds, ReserveFormKey_FreshlyCreatedEmptyPlugin_
    // NeverReturnsFormIdZero, ReserveFormKey_LoadedEmptyPluginWithZeroNextFormId_
    // NeverReturnsFormIdZero, ReserveFormKey_SequentialCalls_ReturnConsecutiveIds — 9 tests) and
    // CreatePlugin_SeedsNextFormIds_PluginIsImmediatelyReservable (a 10th, CreatePlugin's own
    // test, observable only through ReserveFormKey) are removed together with ReserveFormKey
    // itself: unwired dead code (no endpoint, no caller outside these tests, superseded by
    // RecordEditService's both-refs collision-safe allocator, #427). Its backing state
    // (`_nextFormIds`, `SafeNextFormId`) had no other reader and is removed with it.

    // --- #422: filter re-materialization ---
    //
    // _filter is a one-shot snapshot (SetFilter's CREATE OR REPLACE TABLE) of whatever matched the
    // filter SQL at the moment it ran. Nothing else keeps it in step, so every mutation path that can
    // change which records match has to re-run it — these pin the SessionManager-side call sites.

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
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);

            manager.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'NowMatches'");
            Assert.Equal(0, manager.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            var pluginPath = Path.Combine(data.DataFolder, "Plugin.esp");
            var onDisk = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName("Plugin.esp"), pluginPath), Fallout4Release.Fallout4);
            onDisk.Npcs.First(n => n.FormKey == npcKey).EditorID = "NowMatches";
            onDisk.WriteToBinary(pluginPath);

            await manager.ReindexPlugin("Plugin.esp");

            var result = manager.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
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
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);

            manager.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'StillMatches'");
            Assert.Equal(1, manager.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            var pluginPath = Path.Combine(data.DataFolder, "Plugin.esp");
            var onDisk = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName("Plugin.esp"), pluginPath), Fallout4Release.Fallout4);
            onDisk.Npcs.First(n => n.FormKey == npcKey).EditorID = "NoLongerMatches";
            onDisk.WriteToBinary(pluginPath);

            await manager.ReindexPlugin("Plugin.esp");

            var result = manager.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(0, result.Total);
        }
    }

    [Fact]
    public async Task ReindexPlugins_AfterBinaryChangeMakesARecordNewlyMatchTheFilter_FilteredListingIncludesIt()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("reindex-plugins-filter-newly-matches")
            .WithPlugin("Plugin.esp", mod => npcKey = mod.Npcs.AddNew("NotMatchingYet").FormKey)
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);

            manager.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'NowMatches'");
            Assert.Equal(0, manager.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            var pluginPath = Path.Combine(data.DataFolder, "Plugin.esp");
            var onDisk = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName("Plugin.esp"), pluginPath), Fallout4Release.Fallout4);
            onDisk.Npcs.First(n => n.FormKey == npcKey).EditorID = "NowMatches";
            onDisk.WriteToBinary(pluginPath);

            await manager.ReindexPlugins(["Plugin.esp"]);

            var result = manager.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(1, result.Total);
            Assert.Equal(npcKey.ToString(), result.Items[0].FormKey);
        }
    }

    [Fact]
    public void LoadUnlistedPlugin_WithRecordsMatchingAnActiveFilter_FilteredListingIncludesThem()
    {
        var data = new PluginFixtureBuilder("load-unlisted-filter")
            .WithPlugin("Base.esp", mod => mod.Npcs.AddNew("BaseNpc"))
            .WithPlugin("Unlisted.esp", mod => mod.Npcs.AddNew("MatchesFilter"), listed: false)
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);

            manager.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'MatchesFilter'");
            Assert.Equal(0, manager.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            manager.LoadUnlistedPlugin(Path.Combine(data.DataFolder, "Unlisted.esp"), "SomeMod");

            var result = manager.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(1, result.Total);
            Assert.Equal("MatchesFilter", result.Items[0].EditorId);
        }
    }

    // --- #400: LoadUnlistedPlugin's loadOrderIndex fallback ---
    //
    // The filter test above is the only unit test that ever drives LoadUnlistedPlugin against a real
    // SessionManager, and it never asserts the resulting LoadOrderIndex — it only checks filter
    // behavior, and it only ever takes the "no shadowing copy, session non-empty" branch of the
    // fallback. The matched-shadow-copy branch (`.Where(...).First()` finding a same-named load-order
    // plugin) and the "session has zero load-order plugins" branch were reachable only through the
    // MEDIT_SMOKE=1-gated smoke test. These three pin all three paths by asserting the index itself.

    [Fact]
    public void LoadUnlistedPlugin_ShadowedByALoadOrderCopy_SharesItsLoadOrderIndex()
    {
        var data = new PluginFixtureBuilder("load-unlisted-shadow")
            .WithPlugin("Base.esp")
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var loadOrderIndex = manager.Session!.Plugins
                .Single(p => p.InLoadOrder && p.Name == "Base.esp").LoadOrderIndex;

            // A second physical copy of the same filename, from a different mod folder — the
            // "shadowed" case LoadUnlistedPlugin exists for (docs on the method itself).
            var shadowFolder = Path.Combine(data.DataFolder, "ShadowMod");
            Directory.CreateDirectory(shadowFolder);
            new Fallout4Mod(ModKey.FromFileName("Base.esp"), Fallout4Release.Fallout4)
                .WriteToBinary(Path.Combine(shadowFolder, "Base.esp"));

            var result = manager.LoadUnlistedPlugin(Path.Combine(shadowFolder, "Base.esp"), "ShadowMod");

            Assert.Equal(loadOrderIndex, result.LoadOrderIndex);
        }
    }

    [Fact]
    public void LoadUnlistedPlugin_NoLoadOrderCopyOfItsName_UsesOnePastTheHighestLoadOrderIndex()
    {
        var data = new PluginFixtureBuilder("load-unlisted-no-match")
            .WithPlugin("Base.esp")
            .WithPlugin("Second.esp")
            .WithPlugin("Unlisted.esp", listed: false)
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var maxLoadOrderIndex = manager.Session!.Plugins.Where(p => p.InLoadOrder).Max(p => p.LoadOrderIndex);

            var result = manager.LoadUnlistedPlugin(Path.Combine(data.DataFolder, "Unlisted.esp"), "SomeMod");

            Assert.Equal(maxLoadOrderIndex + 1, result.LoadOrderIndex);
        }
    }

    [Fact]
    public void LoadUnlistedPlugin_SessionHasNoLoadOrderPlugins_UsesIndexZero()
    {
        var data = new PluginFixtureBuilder("load-unlisted-empty-session")
            .WithPlugin("Unlisted.esp", listed: false)
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            Assert.Empty(manager.Session!.Plugins);

            var result = manager.LoadUnlistedPlugin(Path.Combine(data.DataFolder, "Unlisted.esp"), "SomeMod");

            Assert.Equal(0, result.LoadOrderIndex);
        }
    }

    // Review finding #1: SetFilter runs raw SQL, so its re-run inside ReapplyFilter can fault for
    // reasons SetFilter's own initial validation never saw — and by the time any of ReapplyFilter's
    // 8 call sites reaches it, the write it followed is already durable. It must degrade to a stale
    // filter and a warning, never a 500 over a gesture that actually succeeded.
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
            using var manager = new SessionManager(faulting, loggerFactory.CreateLogger<SessionManager>());

            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            manager.SetFilter("SELECT form_key FROM npc_");
            faulting.FaultNextCall = true;

            var ex = await Record.ExceptionAsync(() => manager.ReindexPlugin("Plugin.esp"));

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

    // #400: UpdateWinners runs once, after IndexProgressively's per-plugin loop — faulting it fails
    // the load synchronously, on the calling thread, after publish, with no gate/thread coordination
    // needed to isolate IndexAndStore's own catch (DisposeCurrentSession) from a later call's cleanup.
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
    public void CreatePlugin_NoSession_ThrowsInvalidOperationException()
    {
        using var manager = MakeManager(); // not loaded
        var ex = Assert.Throws<InvalidOperationException>(() => manager.CreatePlugin("New.esp", "/tmp/SomeMod", "SomeMod"));
        Assert.Contains("No session", ex.Message);
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
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);
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
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);

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
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);

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
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var modFolder = Path.Combine(data.DataFolder, "BrandNewMod");
            Assert.False(Directory.Exists(modFolder));

            manager.CreatePlugin("New.esp", modFolder, "BrandNewMod");

            Assert.True(File.Exists(Path.Combine(modFolder, "New.esp")));
        }
    }

    // --- Disposal actually releases resources ---

    [Fact]
    public void Load_SecondLoad_OldRepositoryBecomesUnusable()
    {
        using var manager = MakeManager();
        manager.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var oldRepo = manager.Repository;

        manager.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data")));
    }


    [Fact]
    public void Dispose_RepositoryBecomesUnusable()
    {
        var manager = MakeManager();
        manager.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var oldRepo = manager.Repository;

        manager.Dispose();

        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data")));
    }

    // --- ReindexPlugins ---

    [Fact]
    public async Task ReindexPlugins_DisposesLoadedMods()
    {
        var data = new PluginFixtureBuilder("reindex-dispose")
            .WithPlugin("Plugin.esp", mod => mod.Npcs.AddNew("DisposeNPC"))
            .Build();
        using (data)
        {
            var spy = new SpyModImporter();
            using var manager = MakeManager(modImporter: spy);
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);

            await manager.ReindexPlugins(["Plugin.esp"]);

            Assert.NotEmpty(spy.LoadedMods);
            Assert.All(spy.LoadedMods, m =>
            {
                Assert.True(m.IsDisposed);
                Assert.NotNull(m.Getter);
            });
        }
    }

    [Fact]
    public async Task ReindexPlugins_AfterBinaryChange_UpdatesRepositoryAndWinners()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("reindex-plugins-batch")
            .WithPlugin("Plugin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("BatchReindexNPC");
                npc.Aggression = Npc.AggressionType.Unaggressive;
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.LoadExplicit(data.DataFolder, data.Plugins, GameRelease.Fallout4);

            // #410: the binary changes underneath the session with nothing in Modbench told about
            // it — written straight through Mutagen, which is also the shape the never-assume-
            // exclusive-ownership rule cares about (xEdit or MO2 rewriting the file between reads).
            var pluginPath = Path.Combine(data.DataFolder, "Plugin.esp");
            var onDisk = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName("Plugin.esp"), pluginPath), Fallout4Release.Fallout4);
            onDisk.Npcs.First(n => n.FormKey == npcKey).Aggression = Npc.AggressionType.Frenzied;
            manager.Session!.GetMod("Plugin.esp", "Data");
            onDisk.WriteToBinary(pluginPath);

            await manager.ReindexPlugins(["Plugin.esp"]);

            var detail = manager.Repository!.GetDocument(npcKey.ToString(), new PluginKey("Plugin.esp", "Data"))!;
            var aggressionValue = detail.Fields.First(f => f.Metadata.Name == "aggression").Value?.ToString();
            Assert.Equal("Frenzied", aggressionValue);
            Assert.True(detail.IsWinner);
        }
    }

    [Fact]
    public async Task ReindexPlugins_EmptyList_Succeeds()
    {
        using var manager = MakeLoadedManager();
        var ex = await Record.ExceptionAsync(() => manager.ReindexPlugins([]));
        Assert.Null(ex);
    }

    // --- Load disposes previous session ---

    // --- helpers ---

    private SessionManager MakeLoadedManager()
    {
        var m = MakeManager();
        m.LoadExplicit(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
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
