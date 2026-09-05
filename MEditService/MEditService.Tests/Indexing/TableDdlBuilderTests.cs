using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

public class TableDdlBuilderTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;
    private readonly TableDdlBuilder _builder;

    public TableDdlBuilderTests()
    {
        _builder = new TableDdlBuilder(_reflector);
    }

    private static DuckDBConnection OpenMemory()
    {
        var conn = new DuckDBConnection("DataSource=:memory:");
        conn.Open();
        return conn;
    }

    // `schema` narrows to one schema (e.g. "mirror" vs the registered view's "main") when a table
    // name exists in both — null keeps the old unqualified behaviour of matching table_name alone.
    private static List<string> GetColumns(DuckDBConnection conn, string tableName, string? schema = null)
    {
        var schemaFilter = schema == null ? "" : $"AND table_schema = '{schema}' ";
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = '{tableName}' {schemaFilter}
            ORDER BY ordinal_position
            """;
        using var reader = cmd.ExecuteReader();
        var columns = new List<string>();
        while (reader.Read()) columns.Add(reader.GetString(0));
        return columns;
    }

    [Fact]
    public void CreateTables_CreatesRegistrationsTable()
    {
        using var conn = OpenMemory();
        TableDdlBuilder.CreateTables(conn);

        var cols = GetColumns(conn, "registrations");
        // ADR-0044: the three facts a registration carries, and no `participates`, which is derived
        // from them.
        Assert.Equal(["plugin", "origin", "load_order_idx", "enabled", "winning"], cols);
    }

    // ADR-0001: the file-mirror half — what the index believes is on disk, kept apart from
    // the registration so that unregistering a plugin never throws away the hash that makes
    // re-registering it cheap.
    [Fact]
    public void CreateTables_CreatesFilesTable()
    {
        using var conn = OpenMemory();
        TableDdlBuilder.CreateTables(conn);

        var cols = GetColumns(conn, "files", "mirror");
        Assert.Equal(["plugin", "origin", "file_path", "content_hash", "index_version"], cols);
    }

    // WorkingTreeOverlay writes and copies rows through one named column list; a column the DDL
    // adds and that list omits is dropped from every row it writes, silently.
    [Theory]
    [InlineData("records")]
    [InlineData("records_committed")]
    public void TheSharedRecordColumnList_NamesEveryColumnOfBothRecordTables_InOrder(string tableName)
    {
        using var conn = OpenMemory();
        TableDdlBuilder.CreateTables(conn);

        var listed = WorkingTreeOverlay.RecordColumnList
            .Split(',').Select(c => c.Trim().Trim('"')).ToList();

        Assert.Equal(GetColumns(conn, tableName, "mirror"), listed);
    }

    [Fact]
    public void CreateRecordTypeViews_CreatesNpcView_WithBaseColumns()
    {
        using var conn = OpenMemory();
        TableDdlBuilder.CreateTables(conn);
        _builder.CreateRecordTypeViews(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, "npc_");
        Assert.Contains("form_key", cols);
        Assert.Contains("plugin", cols);
        Assert.Contains("load_order_idx", cols);
        Assert.Contains("is_winner", cols);
        Assert.Contains("editor_id", cols);
    }

    [Fact]
    public void CreateTablesAndRecordTypeViews_AreIdempotent()
    {
        using var conn = OpenMemory();
        TableDdlBuilder.CreateTables(conn);
        _builder.CreateRecordTypeViews(conn, GameRelease.Fallout4);

        var ex = Record.Exception(() =>
        {
            TableDdlBuilder.CreateTables(conn);
            _builder.CreateRecordTypeViews(conn, GameRelease.Fallout4);
        });

        Assert.Null(ex);
        // Positive control: the second call left a working schema behind rather than an empty one —
        // a no-op that also dropped every relation would satisfy "did not throw" on its own.
        Assert.NotEmpty(GetColumns(conn, "records"));
        Assert.NotEmpty(GetColumns(conn, "npc_"));
    }

    // ADR-0001: load order lives only on `registrations`. The mirror record-shaped
    // tables carry file-derived facts only; `load_order_idx` reaches a reader exclusively through
    // the registered view's join to `registrations` (TableDdlBuilder.CreateRegisteredViews), never
    // as a stored column.
    [Theory]
    [InlineData("records")]
    [InlineData("records_committed")]
    [InlineData("form_lookup")]
    public void MirrorRecordShapedTables_CarryNoLoadOrderColumn(string tableName)
    {
        using var conn = OpenMemory();
        TableDdlBuilder.CreateTables(conn);

        var cols = GetColumns(conn, tableName, schema: "mirror");
        Assert.NotEmpty(cols); // premise: the mirror table actually exists
        Assert.DoesNotContain("load_order_idx", cols);
    }

    // The registered view over each of those mirror tables still answers `load_order_idx` — derived
    // by joining `registrations`, the one place the value is stored — so every existing reader
    // that names the view keeps working unchanged.
    [Theory]
    [InlineData("records")]
    [InlineData("records_committed")]
    [InlineData("form_lookup")]
    public void RegisteredViews_StillExposeLoadOrderIndex_DerivedFromRegistrations(string tableName)
    {
        using var conn = OpenMemory();
        TableDdlBuilder.CreateTables(conn);

        var cols = GetColumns(conn, tableName, schema: "main");
        Assert.Contains("load_order_idx", cols);
    }

    // ADR-0001: the same split for `is_winner`.
    [Theory]
    [InlineData("records")]
    [InlineData("records_committed")]
    [InlineData("form_lookup")]
    public void MirrorRecordShapedTables_CarryNoWinnerColumn(string tableName)
    {
        using var conn = OpenMemory();
        TableDdlBuilder.CreateTables(conn);

        var cols = GetColumns(conn, tableName, schema: "mirror");
        Assert.NotEmpty(cols); // premise: the mirror table actually exists
        Assert.DoesNotContain("is_winner", cols);
    }

    // The three relations whose readers ask for `is_winner` keep answering it. `records_committed` is
    // not among them: records_head derives Head's own answer, so it stops existing rather than
    // becoming a derived column nobody selects.
    [Theory]
    [InlineData("records", true)]
    [InlineData("form_lookup", true)]
    [InlineData("records_head", true)]
    [InlineData("records_committed", false)]
    public void RegisteredViews_ExposeWinner_OnlyWhereAReaderAsksForIt(string relation, bool exposesWinner)
    {
        using var conn = OpenMemory();
        TableDdlBuilder.CreateTables(conn);

        var cols = GetColumns(conn, relation, schema: "main");
        Assert.NotEmpty(cols); // premise: the view actually exists
        Assert.Equal(exposesWinner, cols.Contains("is_winner"));
    }

    // The load order-winners relation itself: (record_ref, form_key) -> (plugin, origin), carrying
    // the ref because Effective and Head can name different winners for one FormKey
    // (TableDdlBuilder.CreateHeadView).
    [Fact]
    public void CreateTables_CreatesWinnersTable_MappingARefAndFormKeyToOnePlugin()
    {
        using var conn = OpenMemory();
        TableDdlBuilder.CreateTables(conn);

        var cols = GetColumns(conn, "winners", schema: "main");
        Assert.Equal(["record_ref", "form_key", "plugin", "origin"], cols);
    }

    [Fact]
    public void CreateFormReferencesTable_CreatesTargetFormKeyIndex()
    {
        using var conn = OpenMemory();
        // Through CreateTables rather than the per-table helper — the helper writes into the
        // `mirror` schema, which only CreateTables creates.
        TableDdlBuilder.CreateTables(conn);

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM duckdb_indexes() WHERE index_name = 'idx_form_references_target'";
        Assert.Equal(1L, cmd.ExecuteScalar());
    }
}
