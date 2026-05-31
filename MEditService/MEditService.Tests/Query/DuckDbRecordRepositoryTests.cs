using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

public class DuckDbRecordRepositoryTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;
    private static readonly ISchemaReflector _reflector = new SchemaReflector();
    private static readonly ITableDdlBuilder _ddl = new TableDdlBuilder(_reflector);

    public DuckDbRecordRepositoryTests(TestPluginFixture fixture) => _fixture = fixture;

    private DuckDbRecordRepository LoadedRepository()
    {
        var repo = new DuckDbRecordRepository(_reflector, _ddl);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName(TestPluginFixture.PluginName),
            Path.Combine(_fixture.DataFolder, TestPluginFixture.PluginName));
        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, 0);
        repo.UpdateWinners();
        return repo;
    }

    // --- GetRecords ---

    [Fact]
    public void GetRecords_ByTable_ReturnsAllRecords()
    {
        using var repo = LoadedRepository();
        var result = repo.GetRecords("npc_", null, null, 100, 0);
        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    [Fact]
    public void GetRecords_WithPluginFilter_ReturnsMatchingOnly()
    {
        using var repo = LoadedRepository();
        var result = repo.GetRecords("npc_", TestPluginFixture.PluginName, null, 100, 0);
        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.Equal(TestPluginFixture.PluginName, r.Plugin));
    }

    [Fact]
    public void GetRecords_WithPluginFilter_WrongPlugin_ReturnsEmpty()
    {
        using var repo = LoadedRepository();
        var result = repo.GetRecords("npc_", "NonExistent.esp", null, 100, 0);
        Assert.Equal(0, result.Total);
        Assert.Empty(result.Items);
    }

    [Fact]
    public void GetRecords_WithSearch_FiltersOnEditorId()
    {
        using var repo = LoadedRepository();
        var result = repo.GetRecords("npc_", null, "TestNPC01", 100, 0);
        Assert.Equal(1, result.Total);
        Assert.Equal("TestNPC01", result.Items[0].EditorId);
    }

    [Fact]
    public void GetRecords_Pagination_RespectsLimitAndOffset()
    {
        using var repo = LoadedRepository();
        var page1 = repo.GetRecords("npc_", null, null, 1, 0);
        var page2 = repo.GetRecords("npc_", null, null, 1, 1);
        Assert.Single(page1.Items);
        Assert.Single(page2.Items);
        Assert.NotEqual(page1.Items[0].FormKey, page2.Items[0].FormKey);
        Assert.Equal(TestPluginFixture.RecordCount, page1.Total);
    }

    // --- GetRecord ---

    [Fact]
    public void GetRecord_WinnerOnly_ReturnsWinner()
    {
        using var repo = LoadedRepository();
        var formKey = _fixture.Npc1FormKey.ToString();

        var record = repo.GetRecord("npc_", formKey, null, winnerOnly: true);

        Assert.NotNull(record);
        Assert.True(record.IsWinner);
        Assert.Equal(formKey, record.FormKey);
        Assert.NotEmpty(record.Fields);
    }

    [Fact]
    public void GetRecord_WithPlugin_ReturnsMatchingPlugin()
    {
        using var repo = LoadedRepository();
        var formKey = _fixture.Npc1FormKey.ToString();

        var record = repo.GetRecord("npc_", formKey, TestPluginFixture.PluginName, winnerOnly: false);

        Assert.NotNull(record);
        Assert.Equal(TestPluginFixture.PluginName, record.Plugin);
    }

    [Fact]
    public void GetRecord_UnknownFormKey_ReturnsNull()
    {
        using var repo = LoadedRepository();

        var record = repo.GetRecord("npc_", "FFFFFF:Unknown.esp", null, winnerOnly: false);

        Assert.Null(record);
    }

    // --- GetAllOverrides ---

    [Fact]
    public void GetAllOverrides_TwoPlugins_OrderedByLoadOrderIndex_WinnerIsHigher()
    {
        var dataFolder = Path.Combine(Path.GetTempPath(), $"medit-duckdb-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dataFolder);
        try
        {
            var modA = new Fallout4Mod(ModKey.FromFileName("PluginA.esm"), Fallout4Release.Fallout4);
            var npc = modA.Npcs.AddNew("SharedNPC");
            var npcKey = npc.FormKey;
            modA.WriteToBinary(Path.Combine(dataFolder, "PluginA.esm"));

            var modALoaded = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName("PluginA.esm"), Path.Combine(dataFolder, "PluginA.esm")),
                Fallout4Release.Fallout4);

            var modB = new Fallout4Mod(ModKey.FromFileName("PluginB.esp"), Fallout4Release.Fallout4);
            modB.ModHeader.MasterReferences.Add(new MasterReference
                { Master = ModKey.FromFileName("PluginA.esm") });
            modB.Npcs.Set(modALoaded.EnumerateMajorRecords<INpcGetter>().First().DeepCopy());

            using var repo = new DuckDbRecordRepository(_reflector, _ddl);
            repo.Initialize(GameRelease.Fallout4);
            repo.Index(modALoaded, 0);
            repo.Index(modB, 1);
            repo.UpdateWinners();

            var overrides = repo.GetAllOverrides("npc_", npcKey.ToString());

            Assert.Equal(2, overrides.Count);
            Assert.Equal(0, overrides[0].LoadOrderIndex);
            Assert.Equal(1, overrides[1].LoadOrderIndex);
            Assert.False(overrides[0].IsWinner);
            Assert.True(overrides[1].IsWinner);
        }
        finally
        {
            Directory.Delete(dataFolder, recursive: true);
        }
    }

    // --- CountRecordsForPlugin ---

    [Fact]
    public void CountRecordsForPlugin_ReturnsCorrectCount()
    {
        using var repo = LoadedRepository();
        var count = repo.CountRecordsForPlugin("npc_", TestPluginFixture.PluginName);
        Assert.Equal(TestPluginFixture.RecordCount, count);
    }

    [Fact]
    public void CountRecordsForPlugin_UnknownPlugin_ReturnsZero()
    {
        using var repo = LoadedRepository();
        var count = repo.CountRecordsForPlugin("npc_", "NonExistent.esp");
        Assert.Equal(0, count);
    }

    // --- FindRecordType ---

    [Fact]
    public void FindRecordType_KnownFormKey_ReturnsTableName()
    {
        using var repo = LoadedRepository();
        var tableName = repo.FindRecordType(_fixture.Npc1FormKey.ToString());
        Assert.Equal("npc_", tableName);
    }

    [Fact]
    public void FindRecordType_UnknownFormKey_ReturnsNull()
    {
        using var repo = LoadedRepository();
        var tableName = repo.FindRecordType("FFFFFF:Unknown.esp");
        Assert.Null(tableName);
    }

    // --- UpdateWinners ---

    [Fact]
    public void UpdateWinners_SinglePlugin_AllRecordsAreWinners()
    {
        using var repo = LoadedRepository();
        var result = repo.GetRecords("npc_", null, null, 100, 0);
        Assert.All(result.Items, r => Assert.True(r.IsWinner));
    }

    // --- SQL injection (parameterized query contract) ---

    [Fact]
    public void FindRecordType_SqlInjectionAttempt_ReturnsNull()
    {
        // Without parameterization "' OR '1'='1" would match every row.
        using var repo = LoadedRepository();
        var result = repo.FindRecordType("' OR '1'='1");
        Assert.Null(result);
    }
}
