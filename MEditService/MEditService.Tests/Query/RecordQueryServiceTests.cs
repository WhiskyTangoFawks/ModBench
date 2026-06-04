using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Query;

public class RecordQueryServiceTests : IClassFixture<TestPluginFixture>, IDisposable
{
    private readonly SessionManager _manager;
    private readonly RecordQueryService _svc;

    public RecordQueryServiceTests(TestPluginFixture fixture)
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        _manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        _manager.Load(fixture.DataFolder, fixture.PluginsTxtPath, GameRelease.Fallout4);
        _svc = new RecordQueryService(_manager, MakePendingChangeService(), reflector, new ConflictClassifier());
    }

    public void Dispose() => _manager.Dispose();

    // --- GET /plugins ---

    [Fact]
    public void GetPlugins_ReturnsLoadedPlugin()
    {
        var plugins = _svc.GetPlugins();

        Assert.Single(plugins);
        Assert.Equal(TestPluginFixture.PluginName, plugins[0].Name);
        Assert.Equal(TestPluginFixture.RecordCount, plugins[0].RecordCount);
    }

    // --- GET /record-types ---

    [Fact]
    public void GetRecordTypes_ReturnsKnownTypes()
    {
        var types = _svc.GetRecordTypes();

        Assert.Contains("npc_", types);
        Assert.Contains("weap", types);
        Assert.True(types.Count >= 20);
    }

    [Fact]
    public void GetRecordTypes_ReturnsTypesInAscendingOrder()
    {
        var types = _svc.GetRecordTypes();
        Assert.Equal(types.Order().ToList(), types);
    }

    // --- GET /records ---

    [Fact]
    public void GetRecords_ByType_ReturnsPaginatedResults()
    {
        var result = _svc.GetRecords(type: "npc_", plugin: null, search: null, limit: 10, offset: 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    [Fact]
    public void GetRecords_SearchByEditorId_FiltersResults()
    {
        var result = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 10, offset: 0);

        Assert.Equal(1, result.Total);
        Assert.Equal("TestNPC01", result.Items[0].EditorId);
    }

    [Fact]
    public void GetRecords_ByPlugin_FiltersResults()
    {
        var result = _svc.GetRecords(type: "npc_", plugin: TestPluginFixture.PluginName, search: null, limit: 10, offset: 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.Equal(TestPluginFixture.PluginName, r.Plugin));
    }

    [Fact]
    public void GetRecords_AllTypes_ReturnsCombinedResults()
    {
        var result = _svc.GetRecords(type: null, plugin: null, search: null, limit: 100, offset: 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    [Fact]
    public void GetRecords_Pagination_RespectsLimitAndOffset()
    {
        var page1 = _svc.GetRecords(type: "npc_", plugin: null, search: null, limit: 1, offset: 0);
        var page2 = _svc.GetRecords(type: "npc_", plugin: null, search: null, limit: 1, offset: 1);

        Assert.Single(page1.Items);
        Assert.Single(page2.Items);
        Assert.NotEqual(page1.Items[0].FormKey, page2.Items[0].FormKey);
        Assert.Equal(TestPluginFixture.RecordCount, page1.Total);
    }

    // --- GET /records/{formKey} ---

    [Fact]
    public void GetRecord_ReturnsWinnerWithFields()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var detail = _svc.GetRecord(fk);

        Assert.NotNull(detail);
        Assert.Equal(fk, detail.FormKey);
        Assert.True(detail.IsWinner);
        Assert.NotEmpty(detail.Fields);
    }

    [Fact]
    public void GetRecord_FieldsHaveMetadata()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var detail = _svc.GetRecord(all.Items[0].FormKey)!;

        Assert.All(detail.Fields, f =>
        {
            Assert.NotEmpty(f.Metadata.Name);
            Assert.Contains(f.Metadata.Type, new[] { "string", "int", "float", "bool", "enum", "formKey", "array", "struct" });
        });
    }

    [Fact]
    public void GetRecord_UnknownFormKey_ReturnsNull()
    {
        var detail = _svc.GetRecord("FFFFFF:Unknown.esp");

        Assert.Null(detail);
    }

    // --- GET /records/{formKey}/compare ---

    [Fact]
    public void GetCompare_SingleOverride_NoDiffs()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var compare = _svc.GetCompare(all.Items[0].FormKey);

        Assert.NotNull(compare);
        Assert.Single(compare.Overrides);
        Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_UnknownFormKey_ReturnsNull()
    {
        var compare = _svc.GetCompare("FFFFFF:Unknown.esp");

        Assert.Null(compare);
    }

    // --- GET /plugins/{plugin}/record-types ---

    [Fact]
    public void GetPluginRecordTypes_ReturnsCountsForPlugin()
    {
        var result = _svc.GetPluginRecordTypes(TestPluginFixture.PluginName);

        var npc = Assert.Single(result, r => r.Type == "npc_");
        Assert.Equal(TestPluginFixture.RecordCount, npc.Count);
        Assert.All(result, r => Assert.True(r.Count > 0));
    }

    [Fact]
    public void GetPluginRecordTypes_ReturnsTypesInAscendingOrder()
    {
        var result = _svc.GetPluginRecordTypes(TestPluginFixture.PluginName);
        var types = result.Select(r => r.Type).ToList();
        Assert.Equal(types.Order().ToList(), types);
    }

    [Fact]
    public void GetPluginRecordTypes_UnknownPlugin_ReturnsEmpty()
    {
        var result = _svc.GetPluginRecordTypes("DoesNotExist.esp");

        Assert.Empty(result);
    }

    // --- GET /records?type=unknown ---

    [Fact]
    public void GetRecords_UnknownType_ReturnsEmptyPagedResult()
    {
        var result = _svc.GetRecords(type: "xxxx", plugin: null, search: null, limit: 10, offset: 0);

        Assert.Equal(0, result.Total);
        Assert.Empty(result.Items);
    }

    // --- GET /records/{formKey}/plugin/{plugin} ---

    [Fact]
    public void GetRecordForPlugin_KnownFormKey_ReturnsRecord()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var detail = _svc.GetRecordForPlugin(fk, TestPluginFixture.PluginName);

        Assert.NotNull(detail);
        Assert.Equal(fk, detail.FormKey);
        Assert.Equal(TestPluginFixture.PluginName, detail.Plugin);
    }

    [Fact]
    public void GetRecordForPlugin_UnknownFormKey_ReturnsNull()
    {
        var detail = _svc.GetRecordForPlugin("FFFFFF:Unknown.esp", TestPluginFixture.PluginName);

        Assert.Null(detail);
    }

    [Fact]
    public void GetRecordForPlugin_UnknownPlugin_ReturnsNull()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var detail = _svc.GetRecordForPlugin(fk, "NonExistent.esp");

        Assert.Null(detail);
    }

    // --- GET /records/{formKey}/type ---

    [Fact]
    public void GetRecordType_KnownFormKey_ReturnsType()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var type = _svc.GetRecordType(fk);

        Assert.Equal("npc_", type);
    }

    [Fact]
    public void GetRecordType_UnknownFormKey_ReturnsNull()
    {
        var type = _svc.GetRecordType("FFFFFF:Unknown.esp");

        Assert.Null(type);
    }

    // --- GET /records/{formKey}/compare — with pending changes ---

    [Fact]
    public void GetCompare_WithPendingChanges_IncludesPendingFieldsInOverride()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        // Stage a pending change for this record
        var changes = MakePendingChangeService();
        var newVal = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement;
        changes.Upsert(fk, TestPluginFixture.PluginName, "npc_",
            new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = newVal },
            "test", null,
            new Dictionary<string, System.Text.Json.JsonElement>());

        var svcWithChanges = new RecordQueryService(_manager, changes, new SchemaReflector(), new ConflictClassifier());
        var compare = svcWithChanges.GetCompare(fk);

        Assert.NotNull(compare);
        var override_ = compare.Overrides.Single(o => o.Plugin == TestPluginFixture.PluginName);
        Assert.NotNull(override_.PendingFields);
        Assert.True(override_.PendingFields!.ContainsKey("aggression"));
    }

    // --- No-session guard clauses ---

    [Fact]
    public void GetPlugins_NoSession_ThrowsInvalidOperationException()
    {
        var unloaded = MakeUnloadedService();
        var ex = Assert.Throws<InvalidOperationException>(() => unloaded.GetPlugins());
        Assert.Contains("No session loaded", ex.Message);
    }

    [Fact]
    public void GetRecords_NoSession_ThrowsInvalidOperationException()
    {
        var unloaded = MakeUnloadedService();
        var ex = Assert.Throws<InvalidOperationException>(() => unloaded.GetRecords("npc_", null, null, 10, 0));
        Assert.Contains("No session loaded", ex.Message);
    }

    [Fact]
    public void GetRecords_AllTypes_ReturnsSortedByEditorId()
    {
        var data = new PluginFixtureBuilder("rqs-sort-records")
            .WithPlugin("SortTest.esp", mod =>
            {
                mod.Npcs.AddNew("Zebra");
                mod.Npcs.AddNew("Apple");
            })
            .Build();
        using (data)
        {
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, MakePendingChangeService(), reflector, new ConflictClassifier());

            var result = svc.GetRecords(type: null, plugin: null, search: null, limit: 10, offset: 0);

            var editorIds = result.Items.Select(r => r.EditorId).ToList();
            Assert.Equal(2, editorIds.Count);
            Assert.Equal(editorIds.OrderBy(e => e, StringComparer.OrdinalIgnoreCase).ToList(), editorIds);
        }
    }

    [Fact]
    public void GetPluginRecordTypes_WithMultipleTypes_ReturnsInAscendingOrder()
    {
        var data = new PluginFixtureBuilder("rqs-sort-types")
            .WithPlugin("MultiType.esp", mod =>
            {
                mod.Npcs.AddNew("TestNPC");
                mod.Weapons.AddNew("TestWeapon");
            })
            .Build();
        using (data)
        {
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, MakePendingChangeService(), reflector, new ConflictClassifier());

            var result = svc.GetPluginRecordTypes("MultiType.esp");
            var types = result.Select(r => r.Type).ToList();

            Assert.True(types.Count >= 2, "Expected at least 2 record types");
            Assert.Equal(types.OrderBy(t => t, StringComparer.OrdinalIgnoreCase).ToList(), types);
        }
    }

    private static DuckDbPendingChangeService MakePendingChangeService()
    {
        var conn = new DuckDBConnection("DataSource=:memory:");
        conn.Open();
        return new DuckDbPendingChangeService(conn);
    }

    private static RecordQueryService MakeUnloadedService()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        return new RecordQueryService(manager, MakePendingChangeService(), reflector, new ConflictClassifier());
    }

    // --- GetRecord / GetRecordForPlugin use FindRecordType, not table scan ---

    [Fact]
    public void GetRecord_UsesFindRecordTypeNotTableScan()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var reflector = new SchemaReflector();
        var inner = new InMemoryRecordRepository(reflector);
        inner.Initialize(GameRelease.Fallout4);
        using var mod = Mutagen.Bethesda.Fallout4.Fallout4Mod.CreateFromBinaryOverlay(
            new Mutagen.Bethesda.Plugins.ModPath(
                Mutagen.Bethesda.Plugins.ModKey.FromFileName(TestPluginFixture.PluginName),
                Path.Combine(_manager.Session!.DataFolderPath, TestPluginFixture.PluginName)),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        inner.Index(mod, 0);
        inner.UpdateWinners();

        var spy = new SpyRecordReader(inner);
        var stubSession = new StubSessionManager(spy, GameRelease.Fallout4);
        var svc = new RecordQueryService(stubSession, MakePendingChangeService(), reflector, new ConflictClassifier());

        spy.Reset();
        var detail = svc.GetRecord(fk);

        Assert.NotNull(detail);
        Assert.Equal(1, spy.FindRecordTypeCalls);
        Assert.Equal(1, spy.GetRecordCalls);
    }

    [Fact]
    public void GetRecordForPlugin_UsesFindRecordTypeNotTableScan()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var reflector = new SchemaReflector();
        var inner = new InMemoryRecordRepository(reflector);
        inner.Initialize(GameRelease.Fallout4);
        using var mod = Mutagen.Bethesda.Fallout4.Fallout4Mod.CreateFromBinaryOverlay(
            new Mutagen.Bethesda.Plugins.ModPath(
                Mutagen.Bethesda.Plugins.ModKey.FromFileName(TestPluginFixture.PluginName),
                Path.Combine(_manager.Session!.DataFolderPath, TestPluginFixture.PluginName)),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        inner.Index(mod, 0);
        inner.UpdateWinners();

        var spy = new SpyRecordReader(inner);
        var stubSession = new StubSessionManager(spy, GameRelease.Fallout4);
        var svc = new RecordQueryService(stubSession, MakePendingChangeService(), reflector, new ConflictClassifier());

        spy.Reset();
        var detail = svc.GetRecordForPlugin(fk, TestPluginFixture.PluginName);

        Assert.NotNull(detail);
        Assert.Equal(1, spy.FindRecordTypeCalls);
        Assert.Equal(1, spy.GetRecordCalls);
    }

    [Fact]
    public void GetRecord_PassesWinnerOnlyTrue()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var reflector = new SchemaReflector();
        var inner = new InMemoryRecordRepository(reflector);
        inner.Initialize(GameRelease.Fallout4);
        using var mod = Mutagen.Bethesda.Fallout4.Fallout4Mod.CreateFromBinaryOverlay(
            new Mutagen.Bethesda.Plugins.ModPath(
                Mutagen.Bethesda.Plugins.ModKey.FromFileName(TestPluginFixture.PluginName),
                Path.Combine(_manager.Session!.DataFolderPath, TestPluginFixture.PluginName)),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        inner.Index(mod, 0);
        inner.UpdateWinners();

        var spy = new SpyRecordReader(inner);
        var stubSession = new StubSessionManager(spy, GameRelease.Fallout4);
        var svc = new RecordQueryService(stubSession, MakePendingChangeService(), reflector, new ConflictClassifier());

        svc.GetRecord(fk);

        Assert.True(spy.LastWinnerOnly);
    }

    [Fact]
    public void GetRecordForPlugin_PassesWinnerOnlyFalse()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var reflector = new SchemaReflector();
        var inner = new InMemoryRecordRepository(reflector);
        inner.Initialize(GameRelease.Fallout4);
        using var mod = Mutagen.Bethesda.Fallout4.Fallout4Mod.CreateFromBinaryOverlay(
            new Mutagen.Bethesda.Plugins.ModPath(
                Mutagen.Bethesda.Plugins.ModKey.FromFileName(TestPluginFixture.PluginName),
                Path.Combine(_manager.Session!.DataFolderPath, TestPluginFixture.PluginName)),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        inner.Index(mod, 0);
        inner.UpdateWinners();

        var spy = new SpyRecordReader(inner);
        var stubSession = new StubSessionManager(spy, GameRelease.Fallout4);
        var svc = new RecordQueryService(stubSession, MakePendingChangeService(), reflector, new ConflictClassifier());

        svc.GetRecordForPlugin(fk, TestPluginFixture.PluginName);

        Assert.False(spy.LastWinnerOnly);
    }

    private sealed class SpyRecordReader(IRecordReader inner) : IRecordReader
    {
        public int FindRecordTypeCalls { get; private set; }
        public int GetRecordCalls { get; private set; }
        public bool? LastWinnerOnly { get; private set; }

        public void Reset() { FindRecordTypeCalls = 0; GetRecordCalls = 0; LastWinnerOnly = null; }

        public string? FindRecordType(string formKey)
        {
            FindRecordTypeCalls++;
            return inner.FindRecordType(formKey);
        }

        public RecordDetail? GetRecord(string tableName, string formKey, string? plugin, bool winnerOnly)
        {
            GetRecordCalls++;
            LastWinnerOnly = winnerOnly;
            return inner.GetRecord(tableName, formKey, plugin, winnerOnly);
        }

        public PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset) =>
            inner.GetRecords(tableName, plugin, search, limit, offset);

        public IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, string formKey) =>
            inner.GetAllOverrides(tableName, formKey);

        public int CountRecordsForPlugin(string tableName, string plugin) =>
            inner.CountRecordsForPlugin(tableName, plugin);

        public PagedResult<RecordSummary> SearchRecords(IReadOnlyList<string> tableNames, string? plugin, string? search, int limit, int offset) =>
            inner.SearchRecords(tableNames, plugin, search, limit, offset);
    }

    private sealed class StubSessionManager(IRecordReader repository, GameRelease release) : ISessionManager
    {
        public IGameSession? Session { get; } = new StubGameSession(release);
        public IRecordReader? Repository => repository;

        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) => throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes) => throw new NotSupportedException();
    }

    private sealed class StubGameSession(GameRelease release) : IGameSession
    {
        public string DataFolderPath => "";
        public GameRelease GameRelease => release;
        public IReadOnlyList<PluginMetadata> Plugins => [];
        public Mutagen.Bethesda.Plugins.Cache.ILinkCache LinkCache => throw new NotSupportedException();
        public Mutagen.Bethesda.Plugins.Records.IModGetter? GetMod(string pluginName) => null;
        public PluginMetadata AddPlugin(string filePath) => throw new NotSupportedException();
        public void Dispose() { }
    }
}
