using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

[Collection(TestPluginFixtureCollection.Name)]
public class SearchRecordsTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private SessionManager MakeLoadedManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory);
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        return manager;
    }

    [Fact]
    public void SearchRecords_SingleTable_MatchesGetRecords()
    {
        using var manager = MakeLoadedManager();
        var reader = manager.Repository!;

        var expected = reader.GetRecords("npc_", null, null, 100, 0);
        var actual = reader.SearchRecords(["npc_"], null, null, 100, 0);

        Assert.Equal(expected.Total, actual.Total);
        Assert.Equal(expected.Items.Count, actual.Items.Count);
    }

    // Issue #210: the picker's search has no `type` filter when a field allows more than one
    // record type (e.g. any object reference), so it goes through the multi-table union path
    // rather than single-table GetRecords — the FormKey-shaped match needs to resolve there too.
    [Fact]
    public void SearchRecords_AcrossTables_ByFormKey_ResolvesRecord()
    {
        using var manager = MakeLoadedManager();
        var reader = manager.Repository!;

        var byEditorId = reader.GetRecords("npc_", null, "TestNPC01", 10, 0);
        var formKey = byEditorId.Items[0].FormKey;

        var result = reader.SearchRecords(["npc_", "weap"], null, formKey, 10, 0);

        Assert.Equal(1, result.Total);
        Assert.Equal(formKey, result.Items[0].FormKey);
    }
}
