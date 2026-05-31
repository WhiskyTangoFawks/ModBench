using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

public class SearchRecordsTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;

    public SearchRecordsTests(TestPluginFixture fixture) => _fixture = fixture;

    private SessionManager MakeLoadedManager()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector), new FieldMetadataMapper());
        var manager = new SessionManager(factory, new PluginWriter(reflector));
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
}
