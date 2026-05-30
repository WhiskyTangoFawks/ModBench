using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Tests.Session;

public class SessionManagerTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;

    private static readonly ISchemaReflector _reflector = new SchemaReflector();
    private static readonly ITableDdlBuilder _ddl = new TableDdlBuilder(_reflector);
    private static readonly IFieldMetadataMapper _mapper = new FieldMetadataMapper();

    public SessionManagerTests(TestPluginFixture fixture) => _fixture = fixture;

    private SessionManager MakeManager() => new(_reflector, _ddl, _mapper);

    [Fact]
    public void Load_PopulatesSessionAndRepository()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        Assert.NotNull(manager.Session);
        Assert.NotNull(manager.Repository);
        Assert.Single(manager.Session.Plugins);
        Assert.Equal(TestPluginFixture.PluginName, manager.Session.Plugins[0].Name);
    }

    [Fact]
    public void Load_IndexesRecordsIntoRepository()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var count = manager.Repository!.CountRecordsForPlugin("npc_", TestPluginFixture.PluginName);

        Assert.Equal(TestPluginFixture.RecordCount, count);
    }

    [Fact]
    public void Load_SetsIsWinnerOnSinglePlugin()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var result = manager.Repository!.GetRecords("npc_", null, null, 100, 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.True(r.IsWinner));
    }

    [Fact]
    public void Unload_ClearsSessionAndRepository()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        manager.Unload();

        Assert.Null(manager.Session);
        Assert.Null(manager.Repository);
    }

    [Fact]
    public void Load_ReplacesExistingSession()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        var firstRepo = manager.Repository;

        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        Assert.NotSame(firstRepo, manager.Repository);
        Assert.NotNull(manager.Session);
    }

    [Fact]
    public void Load_WithGameRelease_SessionHasCorrectGameRelease()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        Assert.Equal(GameRelease.Fallout4, manager.Session!.GameRelease);
    }
}
