using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

[Collection(TestPluginFixtureCollection.Name)]
public class FilterTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private DuckDbRecordIndex LoadedRepository()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName(TestPluginFixture.PluginName),
            Path.Combine(_fixture.DataFolder, TestPluginFixture.PluginName));
        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();
        return repo;
    }

    // --- SetFilter: validation ---

    [Fact]
    public void SetFilter_ValidSqlWithExtraColumns_FiltersByFormKey()
    {
        // A filter projecting extra columns beyond form_key is accepted and still filters.
        using var repo = LoadedRepository();
        var all = repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        var firstFormKey = all.Items[0].FormKey;

        repo.SetFilter($"SELECT '{firstFormKey}' AS form_key, 'x' AS plugin");

        var filtered = repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal(1, filtered.Total);
        Assert.Equal(firstFormKey, filtered.Items[0].FormKey);
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
        var all = repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal(TestPluginFixture.RecordCount, all.Total);

        // filter to first record only
        var firstFormKey = all.Items[0].FormKey;
        repo.SetFilter($"SELECT '{firstFormKey}' AS form_key");

        var filtered = repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal(1, filtered.Total);
        Assert.Equal(firstFormKey, filtered.Items[0].FormKey);
    }

    [Fact]
    public void GetRecords_AfterClearFilter_ReturnsAllRecords()
    {
        using var repo = LoadedRepository();
        var all = repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        var firstFormKey = all.Items[0].FormKey;

        repo.SetFilter($"SELECT '{firstFormKey}' AS form_key");
        repo.SetFilter(null);

        var restored = repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal(TestPluginFixture.RecordCount, restored.Total);
    }

    // --- SetFilter: filter injection into SearchRecords ---

    [Fact]
    public void SearchRecords_WithActiveFilter_ReturnsOnlyMatchingRecords()
    {
        using var repo = LoadedRepository();
        var all = repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal(TestPluginFixture.RecordCount, all.Total);

        var firstFormKey = all.Items[0].FormKey;
        repo.SetFilter($"SELECT '{firstFormKey}' AS form_key");

        var filtered = repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal(1, filtered.Total);
        Assert.Equal(firstFormKey, filtered.Items[0].FormKey);
    }

    // --- SetFilter: filter injection into CountRecordsForPlugin ---

    [Fact]
    public void CountRecordsForPlugin_WithActiveFilter_CountsOnlyMatching()
    {
        using var repo = LoadedRepository();
        var all = repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        var firstFormKey = all.Items[0].FormKey;

        repo.SetFilter($"SELECT '{firstFormKey}' AS form_key");

        var count = repo.At(RecordRef.Effective).GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "NPC_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0;
        Assert.Equal(1, count);
    }

    // --- GetPluginsWithMatchingRecords ---

    [Fact]
    public void GetPluginsWithMatchingRecords_WithActiveFilter_ReturnsPluginWithMatches()
    {
        using var repo = LoadedRepository();
        var all = repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        var firstFormKey = all.Items[0].FormKey;

        repo.SetFilter($"SELECT '{firstFormKey}' AS form_key");

        var plugins = repo.At(RecordRef.Effective).GetPluginsWithMatchingRecords(["NPC_"]);
        Assert.Contains(TestPluginFixture.PluginName, plugins);
    }

    [Fact]
    public void GetPluginsWithMatchingRecords_NoMatchingRecords_ReturnsEmpty()
    {
        using var repo = LoadedRepository();
        repo.SetFilter("SELECT 'NonExistentFormKey:000000' AS form_key");

        var plugins = repo.At(RecordRef.Effective).GetPluginsWithMatchingRecords(["NPC_"]);
        Assert.Empty(plugins);
    }

    [Fact]
    public void GetPluginsWithMatchingRecords_EmptyTableList_ReturnsEmpty()
    {
        using var repo = LoadedRepository();
        repo.SetFilter($"SELECT form_key FROM \"NPC_\"");

        var plugins = repo.At(RecordRef.Effective).GetPluginsWithMatchingRecords([]);
        Assert.Empty(plugins);
    }
}
