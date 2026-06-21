using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
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
        Assert.Equal("TestNPC01", record.EditorId);
    }

    [Fact]
    public void GetRecord_BitmaskField_AboveSafeInteger_SerializesAsDecimalString()
    {
        var dataFolder = Path.Combine(Path.GetTempPath(), $"medit-bitmask-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dataFolder);
        try
        {
            // 2^53 + 1 — not exactly representable as an IEEE 754 float64.
            // Race.Flag is a [Flags] ulong split across two 32-bit DATA fields, so bit 53 survives binary round-trip.
            const long combined = 9007199254740993;
            var mod = new Fallout4Mod(ModKey.FromFileName("Flags.esp"), Fallout4Release.Fallout4);
            var race = mod.Races.AddNew("HighBitRace");
            race.Flags = (Race.Flag)(ulong)combined;
            var formKey = race.FormKey.ToString();
            mod.WriteToBinary(Path.Combine(dataFolder, "Flags.esp"));

            var loaded = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName("Flags.esp"), Path.Combine(dataFolder, "Flags.esp")),
                Fallout4Release.Fallout4);

            using var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
            repo.Initialize(GameRelease.Fallout4);
            repo.Index(loaded, 0);
            repo.UpdateWinners();

            var record = repo.GetRecord("race", formKey, null, winnerOnly: false);

            Assert.NotNull(record);
            var flags = record.Fields.Single(f => f.Metadata.Name == "flags");
            Assert.True(flags.Metadata.IsBitmask);
            Assert.Equal("9007199254740993", flags.Value);
        }
        finally
        {
            Directory.Delete(dataFolder, recursive: true);
        }
    }

    [Fact]
    public void GetRecord_UnknownFormKey_ReturnsNull()
    {
        using var repo = LoadedRepository();

        var record = repo.GetRecord("npc_", "FFFFFF:Unknown.esp", null, winnerOnly: false);

        Assert.Null(record);
    }

    [Fact]
    public void GetRecord_WinnerOnly_True_ReturnsWinnerNotEarlierOverride()
    {
        var dataFolder = Path.Combine(Path.GetTempPath(), $"medit-winner-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dataFolder);
        try
        {
            var modA = new Fallout4Mod(ModKey.FromFileName("PluginA.esm"), Fallout4Release.Fallout4);
            var npcKey = modA.Npcs.AddNew("SharedNPC").FormKey;
            modA.WriteToBinary(Path.Combine(dataFolder, "PluginA.esm"));

            var modALoaded = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName("PluginA.esm"), Path.Combine(dataFolder, "PluginA.esm")),
                Fallout4Release.Fallout4);

            var modB = new Fallout4Mod(ModKey.FromFileName("PluginB.esp"), Fallout4Release.Fallout4);
            modB.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("PluginA.esm") });
            modB.Npcs.Set(modALoaded.EnumerateMajorRecords<INpcGetter>().First().DeepCopy());

            using var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
            repo.Initialize(GameRelease.Fallout4);
            repo.Index(modALoaded, 0);
            repo.Index(modB, 1);
            repo.UpdateWinners();

            var record = repo.GetRecord("npc_", npcKey.ToString(), null, winnerOnly: true);

            Assert.NotNull(record);
            Assert.True(record.IsWinner);
            Assert.Equal("PluginB.esp", record.Plugin);
        }
        finally
        {
            Directory.Delete(dataFolder, recursive: true);
        }
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

            using var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
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

    // --- Array field deserialization ---

    [Fact]
    public void GetRecord_ArrayField_ValueIsJsonArrayNotString()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-array")
            .WithPlugin("ArrayTest.esm", mod =>
            {
                var npc = mod.Npcs.AddNew("KeywordedNPC");
                npcFormKey = npc.FormKey;
                npc.Keywords =
                [
                    new FormLink<IKeywordGetter>(FormKey.Factory("000001:ArrayTest.esm")),
                    new FormLink<IKeywordGetter>(FormKey.Factory("000002:ArrayTest.esm")),
                ];
            })
            .Build();

        var loaded = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("ArrayTest.esm"),
                Path.Combine(fixture.DataFolder, "ArrayTest.esm")),
            Fallout4Release.Fallout4);

        using var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index(loaded, 0);
        repo.UpdateWinners();

        var record = repo.GetRecord("npc_", npcFormKey.ToString(), null, winnerOnly: true);

        Assert.NotNull(record);
        var keywordsField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "keywords");
        Assert.NotNull(keywordsField);
        var element = Assert.IsType<JsonElement>(keywordsField.Value);
        Assert.Equal(JsonValueKind.Array, element.ValueKind);
        Assert.Equal(2, element.GetArrayLength());
    }

    // --- Combined filter (kills AND-separator string mutant in BuildWhere) ---

    [Fact]
    public void GetRecords_WithPluginAndSearchFilter_AndFiltersApply()
    {
        using var repo = LoadedRepository();
        // Both conditions active — exercises the AND separator in BuildWhere.
        // Non-existent plugin + matching search = 0 results (not "all matching search").
        var result = repo.GetRecords("npc_", "NonExistent.esp", "TestNPC", 100, 0);
        Assert.Equal(0, result.Total);
    }

    // --- SearchRecords with filter (kills AddParams mutants) ---

    [Fact]
    public void SearchRecords_WithPluginFilter_ReturnsMatchingOnly()
    {
        var dataFolder = Path.Combine(Path.GetTempPath(), $"medit-search-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dataFolder);
        try
        {
            var modA = new Fallout4Mod(ModKey.FromFileName("SearchA.esm"), Fallout4Release.Fallout4);
            modA.Npcs.AddNew("NPC_A");
            modA.WriteToBinary(Path.Combine(dataFolder, "SearchA.esm"));

            var modB = new Fallout4Mod(ModKey.FromFileName("SearchB.esp"), Fallout4Release.Fallout4);
            modB.Npcs.AddNew("NPC_B");
            modB.WriteToBinary(Path.Combine(dataFolder, "SearchB.esp"));

            var modALoaded = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName("SearchA.esm"), Path.Combine(dataFolder, "SearchA.esm")),
                Fallout4Release.Fallout4);
            var modBLoaded = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName("SearchB.esp"), Path.Combine(dataFolder, "SearchB.esp")),
                Fallout4Release.Fallout4);

            using var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
            repo.Initialize(GameRelease.Fallout4);
            repo.Index(modALoaded, 0);
            repo.Index(modBLoaded, 1);
            repo.UpdateWinners();

            var result = repo.SearchRecords(["npc_"], "SearchA.esm", null, 100, 0);

            Assert.Equal(1, result.Total);
            Assert.All(result.Items, r => Assert.Equal("SearchA.esm", r.Plugin));
        }
        finally
        {
            Directory.Delete(dataFolder, recursive: true);
        }
    }

    // --- Null EditorID round-trip (kills ReadSummary/ReadDetail conditional mutants) ---

    [Fact]
    public void GetRecord_NullEditorId_ReturnsNullEditorId()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-null-edid")
            .WithPlugin("NullEdId.esm", mod =>
            {
                npcFormKey = mod.GetNextFormKey();
                mod.Npcs.Set(new Npc(npcFormKey, Fallout4Release.Fallout4) { EditorID = null });
            })
            .Build();

        var loaded = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("NullEdId.esm"),
                Path.Combine(fixture.DataFolder, "NullEdId.esm")),
            Fallout4Release.Fallout4);

        using var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index(loaded, 0);
        repo.UpdateWinners();

        var summary = repo.GetRecords("npc_", null, null, 100, 0).Items.Single();
        Assert.Null(summary.EditorId);

        var detail = repo.GetRecord("npc_", npcFormKey.ToString(), null, winnerOnly: false);
        Assert.NotNull(detail);
        Assert.Null(detail.EditorId);
    }

    // --- Use before Initialize (kills RequireSchemas null-coalescing mutant) ---

    [Fact]
    public void GetRecord_BeforeInitialize_Throws()
    {
        var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
        var ex = Assert.Throws<InvalidOperationException>(() =>
            repo.GetRecord("npc_", "000001:Test.esp", null, winnerOnly: false));
        Assert.Equal("Call Initialize before using the repository.", ex.Message);
        repo.Dispose();
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

    // --- Dispose (DuckDBConnection.Dispose is idempotent) ---

    [Fact]
    public void Dispose_CalledTwice_DoesNotThrow()
    {
        var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Dispose();
        var ex = Record.Exception(() => repo.Dispose());
        Assert.Null(ex);
    }

    // --- AppendTyped: DOUBLE branch ---

    [Fact]
    public void AppendTyped_Double_AppendsCorrectValue()
    {
        using var conn = new DuckDBConnection("DataSource=:memory:");
        conn.Open();
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "CREATE TABLE t (v DOUBLE)";
            cmd.ExecuteNonQuery();
        }

        using (var appender = conn.CreateAppender("t"))
        {
            var row = appender.CreateRow();
            DuckDbRecordRepository.AppendTyped(row, 3.14, "DOUBLE");
            row.EndRow();
        }

        using var q = conn.CreateCommand();
        q.CommandText = "SELECT v FROM t";
        var result = q.ExecuteScalar();
        Assert.NotNull(result);
        Assert.Equal(3.14, (double)result, precision: 5);
    }

    [Fact]
    public void AppendTyped_Null_AppendsNullValue()
    {
        using var conn = new DuckDBConnection("DataSource=:memory:");
        conn.Open();
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "CREATE TABLE t (v DOUBLE)";
            cmd.ExecuteNonQuery();
        }

        using (var appender = conn.CreateAppender("t"))
        {
            var row = appender.CreateRow();
            DuckDbRecordRepository.AppendTyped(row, null, "DOUBLE");
            row.EndRow();
        }

        using var q = conn.CreateCommand();
        q.CommandText = "SELECT v IS NULL FROM t";
        Assert.Equal(true, q.ExecuteScalar());
    }

    // --- ColumnList: zero-column and non-empty branches ---

    [Fact]
    public void ColumnList_ZeroColumns_ReturnsEmptyString()
    {
        var schema = new RecordTableSchema { TableName = "t", RecordType = typeof(object), RecordColumns = [] };
        Assert.Equal("", DuckDbRecordRepository.ColumnList(schema));
    }

    [Fact]
    public void ColumnList_WithColumns_ReturnsCommaSeparatedQuotedNames()
    {
        var col = new ColumnSpec("my_col", "MyProp", "VARCHAR", _ => null, "string", [], [], null);
        var schema = new RecordTableSchema { TableName = "t", RecordType = typeof(object), RecordColumns = [col] };
        Assert.Equal(", \"my_col\"", DuckDbRecordRepository.ColumnList(schema));
    }

    // --- ReadDetail: null scalar field returns C# null, not DBNull ---

    [Fact]
    public void GetRecord_UnsetFormLinkField_ReturnsNull()
    {
        // Unset FormLink fields are appended as null → IsDBNull=true → must return C# null not DBNull.Value
        using var repo = LoadedRepository();
        var formKey = _fixture.Npc1FormKey.ToString();
        var record = repo.GetRecord("npc_", formKey, null, winnerOnly: true);
        Assert.NotNull(record);
        var linkField = record.Fields.FirstOrDefault(f => f.Metadata.Type == "formKey" && f.Value == null);
        Assert.NotNull(linkField); // NPC has unset FormLink fields → null in DuckDB
    }

    [Fact]
    public void GetRecord_FloatField_ReturnsNonNullValue()
    {
        // Float fields (height, weight) are value types — always non-null in DuckDB
        using var repo = LoadedRepository();
        var formKey = _fixture.Npc1FormKey.ToString();
        var record = repo.GetRecord("npc_", formKey, null, winnerOnly: true);
        Assert.NotNull(record);
        var floatField = record.Fields.FirstOrDefault(f => f.Metadata.Type == "float");
        Assert.NotNull(floatField);
        Assert.NotNull(floatField.Value); // float value type is never null
    }

    // --- CheckError ---

    [Fact]
    public void GetRecord_DanglingKeywordReference_CheckErrorOnKeywordsField()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-checkerror-dangling")
            .WithPlugin("Dangling.esm", mod =>
            {
                var npc = mod.Npcs.AddNew("DanglingRefNPC");
                npcFormKey = npc.FormKey;
                npc.Keywords = [new FormLink<IKeywordGetter>(FormKey.Factory("FFFFFF:Dangling.esm"))];
            })
            .Build();

        var loaded = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Dangling.esm"),
                Path.Combine(fixture.DataFolder, "Dangling.esm")),
            Fallout4Release.Fallout4);

        using var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index(loaded, 0);
        repo.UpdateWinners();

        var record = repo.GetRecord("npc_", npcFormKey.ToString(), null, winnerOnly: true);
        Assert.NotNull(record);
        var keywordsField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "keywords");
        Assert.NotNull(keywordsField);
        Assert.Equal("[0]: [FFFFFF:Dangling.esm] <Error: Could not be resolved>", keywordsField.CheckError);
    }

    [Fact]
    public void GetRecord_KeywordReferenceResolvesInSession_CheckErrorIsNull()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-checkerror-clean")
            .WithPlugin("Clean.esm", mod =>
            {
                var keyword = mod.Keywords.AddNew("TestKeyword");
                var npc = mod.Npcs.AddNew("CleanRefNPC");
                npcFormKey = npc.FormKey;
                npc.Keywords = [new FormLink<IKeywordGetter>(keyword.FormKey)];
            })
            .Build();

        var loaded = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Clean.esm"),
                Path.Combine(fixture.DataFolder, "Clean.esm")),
            Fallout4Release.Fallout4);

        using var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index(loaded, 0);
        repo.UpdateWinners();

        var record = repo.GetRecord("npc_", npcFormKey.ToString(), null, winnerOnly: true);
        Assert.NotNull(record);
        var keywordsField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "keywords");
        Assert.NotNull(keywordsField);
        Assert.Null(keywordsField.CheckError);
    }

    [Fact]
    public void GetAllOverrides_SharedKeywordRef_CheckErrorConsistentAcrossOverrides()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-checkerror-shared")
            .WithPlugin("Base.esm", mod =>
            {
                var keyword = mod.Keywords.AddNew("SharedKw");
                var npc = mod.Npcs.AddNew("SharedNPC");
                npcFormKey = npc.FormKey;
                npc.Keywords = [new FormLink<IKeywordGetter>(keyword.FormKey)];
            })
            .WithPlugin("Patch.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            })
            .Build();

        var baseMod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Base.esm"), Path.Combine(fixture.DataFolder, "Base.esm")),
            Fallout4Release.Fallout4);
        var patchMod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Patch.esp"), Path.Combine(fixture.DataFolder, "Patch.esp")),
            Fallout4Release.Fallout4);

        using var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index(baseMod, 0);
        repo.Index(patchMod, 1);
        repo.UpdateWinners();

        var overrides = repo.GetAllOverrides("npc_", npcFormKey.ToString());

        Assert.Equal(2, overrides.Count);
        var baseKw = overrides[0].Fields.FirstOrDefault(f => f.Metadata.Name == "keywords");
        var patchKw = overrides[1].Fields.FirstOrDefault(f => f.Metadata.Name == "keywords");
        Assert.NotNull(baseKw);
        Assert.NotNull(patchKw);
        Assert.Null(baseKw.CheckError);
        Assert.Null(patchKw.CheckError);
    }
}
