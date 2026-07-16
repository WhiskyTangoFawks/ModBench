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

    private static List<string> GetColumns(DuckDBConnection conn, string tableName)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT column_name FROM information_schema.columns WHERE table_name = '{tableName}' ORDER BY ordinal_position";
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

    [Fact]
    public void CreateFormReferencesTable_CreatesTargetFormKeyIndex()
    {
        using var conn = OpenMemory();
        TableDdlBuilder.CreateFormReferencesTable(conn);

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM duckdb_indexes() WHERE index_name = 'idx_form_references_target'";
        Assert.Equal(1L, cmd.ExecuteScalar());
    }

    [Fact]
    public void EnsureTable_CreatesPendingRefTargetIndex()
    {
        using var conn = OpenMemory();
        DuckDbPendingChangeService.EnsureTable(conn);

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM duckdb_indexes() WHERE index_name = 'idx_pfr_target'";
        Assert.Equal(1L, cmd.ExecuteScalar());
    }
}
