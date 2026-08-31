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
        _builder.CreateTables(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, "registrations");
        // ADR-0044: the three facts a registration carries — and no `participates`, which is
        // derived from them, never stored.
        // ADR-0001: the load order, and only the load order. Nothing about the file — that
        // is mirror.files below — and above all no `file_mtime`, the clock-based check the
        // decision exists to rule out.
        Assert.Equal(["plugin", "origin", "load_order_idx", "enabled", "winning"], cols);
    }

    // ADR-0001: the file-mirror half — what the index believes is on disk, kept apart from
    // the registration so that unregistering a plugin never throws away the hash that makes
    // re-registering it cheap.
    [Fact]
    public void CreateTables_CreatesFilesTable()
    {
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, "files", "mirror");
        Assert.Equal(["plugin", "origin", "file_path", "content_hash", "index_version"], cols);
    }

    [Fact]
    public void CreateTables_CreatesNpcTable_WithBaseColumns()
    {
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, "npc_");
        Assert.Contains("form_key", cols);
        Assert.Contains("plugin", cols);
        Assert.Contains("load_order_idx", cols);
        Assert.Contains("is_winner", cols);
        Assert.Contains("editor_id", cols);
    }

    [Fact]
    public void CreateTables_CreatesHeaderTable_WithAuthorFlagsMastersColumns()
    {
        // The header table is entirely schema-driven — no DDL changes
        // needed once SchemaReflector's schemas dictionary carries a "header" entry.
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, "header");
        Assert.Contains("form_key", cols);
        Assert.Contains("plugin", cols);
        Assert.Contains("load_order_idx", cols);
        Assert.Contains("is_winner", cols);
        Assert.Contains("editor_id", cols);
        Assert.Contains("author", cols);
        Assert.Contains("flags", cols);
        Assert.Contains("masters", cols);
    }

    [Fact]
    public void CreateTables_IsIdempotent()
    {
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);
        _builder.CreateTables(conn, GameRelease.Fallout4); // should not throw
    }

    // ADR-0001: load order lives only on `registrations`. The mirror record-shaped
    // tables carry file-derived facts only; `load_order_idx` reaches a reader exclusively through
    // the registered view's join to `registrations` (TableDdlBuilder.CreateRegisteredViews), never
    // as a stored column.
    [Theory]
    [InlineData("records")]
    [InlineData("records_committed")]
    [InlineData("form_lookup")]
    [InlineData("header")]
    public void MirrorRecordShapedTables_CarryNoLoadOrderColumn(string tableName)
    {
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);

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
    [InlineData("header")]
    public void RegisteredViews_StillExposeLoadOrderIndex_DerivedFromRegistrations(string tableName)
    {
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, tableName, schema: "main");
        Assert.Contains("load_order_idx", cols);
    }

    // ADR-0001: the same split for `is_winner`. Winning is a fact about the whole registered
    // stack a FormKey sits in, not about one row's bytes, so no mirror table stores it — it is
    // derived in the registered view by joining `winners`, the load order-owned table the sweep
    // rebuilds.
    [Theory]
    [InlineData("records")]
    [InlineData("records_committed")]
    [InlineData("form_lookup")]
    [InlineData("header")]
    public void MirrorRecordShapedTables_CarryNoWinnerColumn(string tableName)
    {
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, tableName, schema: "mirror");
        Assert.NotEmpty(cols); // premise: the mirror table actually exists
        Assert.DoesNotContain("is_winner", cols);
    }

    // The three relations whose readers ask for `is_winner` keep answering it. `records_committed` is
    // not among them: its stored flag was written FALSE and read by nothing — records_head derives
    // Head's own answer — so it stops existing rather than becoming a derived column nobody selects.
    [Theory]
    [InlineData("records", true)]
    [InlineData("form_lookup", true)]
    [InlineData("header", true)]
    [InlineData("records_head", true)]
    [InlineData("records_committed", false)]
    public void RegisteredViews_ExposeWinner_OnlyWhereAReaderAsksForIt(string relation, bool exposesWinner)
    {
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, relation, schema: "main");
        Assert.NotEmpty(cols); // premise: the view actually exists
        Assert.Equal(exposesWinner, cols.Contains("is_winner"));
    }

    // The load order-winners relation itself: (record_ref, form_key) -> (plugin, origin), carrying the
    // ref because Effective and Head can name different winners for one FormKey
    // (TableDdlBuilder.CreateHeadView). Bare in `main`, not the mirror schema — it is
    // load-order-derived, not a file mirror.
    [Fact]
    public void CreateTables_CreatesWinnersTable_MappingARefAndFormKeyToOnePlugin()
    {
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, "winners", schema: "main");
        Assert.Equal(["record_ref", "form_key", "plugin", "origin"], cols);
    }

    [Fact]
    public void CreateFormReferencesTable_CreatesTargetFormKeyIndex()
    {
        using var conn = OpenMemory();
        // Through CreateTables rather than the per-table helper — the helper writes into the
        // `mirror` schema, which only CreateTables creates.
        _builder.CreateTables(conn, GameRelease.Fallout4);

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM duckdb_indexes() WHERE index_name = 'idx_form_references_target'";
        Assert.Equal(1L, cmd.ExecuteScalar());
    }
}
