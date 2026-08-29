using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

public class TableDdlBuilderTests
{
    private readonly ISchemaReflector _reflector = SharedSchemaReflector.Instance;
    private readonly ITableDdlBuilder _builder;

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

    // `schema` narrows to one schema (e.g. "raw" vs the registered view's "main") when a table name
    // exists in both — null keeps the old unqualified behaviour of matching table_name alone.
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
    public void CreateTables_CreatesPluginsTable()
    {
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, "plugins");
        Assert.Contains("plugin", cols);
        Assert.Contains("load_order_idx", cols);
        Assert.Contains("file_mtime", cols);
        Assert.Contains("participates", cols); // #267 / ADR-0035
    }

    [Fact]
    public void CreateTables_CreatesIndexStateTable()
    {
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, "index_state");
        Assert.Contains("load_order_hash", cols);
        Assert.Contains("indexed_at", cols);
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
        // Issue #1 slice A1: the header table is entirely schema-driven — no DDL changes
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

    // #583 / ADR-0001: load order lives only on `plugins` now. The raw record-shaped tables carry
    // file-derived facts only; `load_order_idx` reaches a reader exclusively through the registered
    // view's join to `plugins` (TableDdlBuilder.CreateRegisteredViews), never as a stored column.
    [Theory]
    [InlineData("records")]
    [InlineData("records_committed")]
    [InlineData("form_lookup")]
    [InlineData("header")]
    public void RawRecordShapedTables_CarryNoLoadOrderColumn(string tableName)
    {
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, tableName, schema: "raw");
        Assert.NotEmpty(cols); // premise: the raw table actually exists
        Assert.DoesNotContain("load_order_idx", cols);
    }

    // The registered view over each of those raw tables still answers `load_order_idx` — derived by
    // joining `plugins`, the one place the value is stored — so every existing reader that names the
    // view keeps working unchanged.
    [Theory]
    [InlineData("records")]
    [InlineData("records_committed")]
    [InlineData("form_lookup")]
    [InlineData("header")]
    public void RegisteredViews_StillExposeLoadOrderIndex_DerivedFromPlugins(string tableName)
    {
        using var conn = OpenMemory();
        _builder.CreateTables(conn, GameRelease.Fallout4);

        var cols = GetColumns(conn, tableName, schema: "main");
        Assert.Contains("load_order_idx", cols);
    }

    [Fact]
    public void CreateFormReferencesTable_CreatesTargetFormKeyIndex()
    {
        using var conn = OpenMemory();
        // #582: through CreateTables rather than the per-table helper — the helper writes into the
        // `raw` schema, which only CreateTables creates.
        _builder.CreateTables(conn, GameRelease.Fallout4);

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM duckdb_indexes() WHERE index_name = 'idx_form_references_target'";
        Assert.Equal(1L, cmd.ExecuteScalar());
    }
}
