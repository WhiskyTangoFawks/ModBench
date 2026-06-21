using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

public class FilterTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;
    private static readonly ISchemaReflector _reflector = new SchemaReflector();
    private static readonly ITableDdlBuilder _ddl = new TableDdlBuilder(_reflector);

    public FilterTests(TestPluginFixture fixture) => _fixture = fixture;

    private DuckDbRecordRepository LoadedRepository()
    {
        var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName(TestPluginFixture.PluginName),
            Path.Combine(_fixture.DataFolder, TestPluginFixture.PluginName));
        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, 0);
        repo.UpdateWinners();
        return repo;
    }

    // --- SetFilter: validation ---

    [Fact]
    public void SetFilter_ValidSql_DoesNotThrow()
    {
        using var repo = LoadedRepository();
        repo.SetFilter("SELECT form_key FROM \"NPC_\"");
    }

    [Fact]
    public void SetFilter_ValidSqlWithExtraColumns_DoesNotThrow()
    {
        using var repo = LoadedRepository();
        Assert.Null(Record.Exception(() => repo.SetFilter("SELECT form_key, plugin FROM \"NPC_\"")));
    }

    [Fact]
    public void SetFilter_SqlWithoutFormKeyColumn_ThrowsArgumentException()
    {
        using var repo = LoadedRepository();
        var ex = Assert.Throws<ArgumentException>(() =>
            repo.SetFilter("SELECT editor_id FROM \"NPC_\""));
        Assert.Contains("form_key", ex.Message);
    }

    [Fact]
    public void SetFilter_BadSyntax_ThrowsException()
    {
        using var repo = LoadedRepository();
        Assert.ThrowsAny<Exception>(() => repo.SetFilter("NOT VALID SQL!!!"));
    }

    // --- SetFilter: filter injection into GetRecords ---

    [Fact]
    public void GetRecords_WithActiveFilter_ReturnsOnlyMatchingRecords()
    {
        using var repo = LoadedRepository();
        var all = repo.GetRecords("NPC_", null, null, 100, 0);
        Assert.Equal(TestPluginFixture.RecordCount, all.Total);

        // filter to first record only
        var firstFormKey = all.Items[0].FormKey;
        repo.SetFilter($"SELECT '{firstFormKey}' AS form_key");

        var filtered = repo.GetRecords("NPC_", null, null, 100, 0);
        Assert.Equal(1, filtered.Total);
        Assert.Equal(firstFormKey, filtered.Items[0].FormKey);
    }

    [Fact]
    public void GetRecords_AfterClearFilter_ReturnsAllRecords()
    {
        using var repo = LoadedRepository();
        var all = repo.GetRecords("NPC_", null, null, 100, 0);
        var firstFormKey = all.Items[0].FormKey;

        repo.SetFilter($"SELECT '{firstFormKey}' AS form_key");
        repo.SetFilter(null);

        var restored = repo.GetRecords("NPC_", null, null, 100, 0);
        Assert.Equal(TestPluginFixture.RecordCount, restored.Total);
    }

    // --- SetFilter: filter injection into SearchRecords ---

    [Fact]
    public void SearchRecords_WithActiveFilter_ReturnsOnlyMatchingRecords()
    {
        using var repo = LoadedRepository();
        var all = repo.SearchRecords(["NPC_"], null, null, 100, 0);
        Assert.Equal(TestPluginFixture.RecordCount, all.Total);

        var firstFormKey = all.Items[0].FormKey;
        repo.SetFilter($"SELECT '{firstFormKey}' AS form_key");

        var filtered = repo.SearchRecords(["NPC_"], null, null, 100, 0);
        Assert.Equal(1, filtered.Total);
        Assert.Equal(firstFormKey, filtered.Items[0].FormKey);
    }

    // --- SetFilter: filter injection into CountRecordsForPlugin ---

    [Fact]
    public void CountRecordsForPlugin_WithActiveFilter_CountsOnlyMatching()
    {
        using var repo = LoadedRepository();
        var all = repo.GetRecords("NPC_", null, null, 100, 0);
        var firstFormKey = all.Items[0].FormKey;

        repo.SetFilter($"SELECT '{firstFormKey}' AS form_key");

        var count = repo.CountRecordsForPlugin("NPC_", TestPluginFixture.PluginName);
        Assert.Equal(1, count);
    }

    // --- GetPluginsWithMatchingRecords ---

    [Fact]
    public void GetPluginsWithMatchingRecords_WithActiveFilter_ReturnsPluginWithMatches()
    {
        using var repo = LoadedRepository();
        var all = repo.GetRecords("NPC_", null, null, 100, 0);
        var firstFormKey = all.Items[0].FormKey;

        repo.SetFilter($"SELECT '{firstFormKey}' AS form_key");

        var plugins = repo.GetPluginsWithMatchingRecords(["NPC_"]);
        Assert.Contains(TestPluginFixture.PluginName, plugins);
    }

    [Fact]
    public void GetPluginsWithMatchingRecords_NoMatchingRecords_ReturnsEmpty()
    {
        using var repo = LoadedRepository();
        repo.SetFilter("SELECT 'NonExistentFormKey:000000' AS form_key");

        var plugins = repo.GetPluginsWithMatchingRecords(["NPC_"]);
        Assert.Empty(plugins);
    }

    [Fact]
    public void GetPluginsWithMatchingRecords_EmptyTableList_ReturnsEmpty()
    {
        using var repo = LoadedRepository();
        repo.SetFilter($"SELECT form_key FROM \"NPC_\"");

        var plugins = repo.GetPluginsWithMatchingRecords([]);
        Assert.Empty(plugins);
    }
}
