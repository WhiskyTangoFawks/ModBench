using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
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
        _manager = new SessionManager(factory, new PluginWriter(reflector));
        _manager.Load(fixture.DataFolder, fixture.PluginsTxtPath, GameRelease.Fallout4);
        _svc = new RecordQueryService(_manager, new PendingChangeService(), reflector, new ConflictClassifier());
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
            Assert.Contains(f.Metadata.Type, new[] { "string", "int", "float", "bool", "enum", "formKey" });
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
        Assert.DoesNotContain(compare.Diffs, d => d.IsConflict);
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
    public void GetPluginRecordTypes_UnknownPlugin_ReturnsEmpty()
    {
        var result = _svc.GetPluginRecordTypes("DoesNotExist.esp");

        Assert.Empty(result);
    }
}
