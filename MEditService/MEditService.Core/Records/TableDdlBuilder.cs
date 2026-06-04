using System.Globalization;
using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

public sealed class TableDdlBuilder : ITableDdlBuilder
{
    private readonly ISchemaReflector _reflector;

    public TableDdlBuilder(ISchemaReflector reflector)
    {
        _reflector = reflector;
    }

    public void CreateTables(DuckDBConnection connection, GameRelease release)
    {
        CreatePluginsTable(connection);
        CreateIndexStateTable(connection);
        foreach (var schema in _reflector.GetSchemas(release).Values)
            CreateRecordTable(connection, schema);
    }

    private static void CreatePluginsTable(DuckDBConnection connection) =>
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS plugins (
                plugin VARCHAR PRIMARY KEY,
                load_order_idx INTEGER NOT NULL,
                is_master BOOLEAN NOT NULL DEFAULT FALSE,
                is_light BOOLEAN NOT NULL DEFAULT FALSE,
                is_writable BOOLEAN NOT NULL DEFAULT FALSE,
                masters VARCHAR[],
                record_count INTEGER,
                file_mtime TIMESTAMP
            )
            """);

    private static void CreateIndexStateTable(DuckDBConnection connection) =>
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS index_state (
                indexed_at TIMESTAMP,
                load_order_hash VARCHAR
            )
            """);

    private static void CreateRecordTable(DuckDBConnection connection, RecordTableSchema schema)
    {
        var sb = new StringBuilder();
        sb.Append("form_key VARCHAR NOT NULL, ");
        sb.Append("plugin VARCHAR NOT NULL, ");
        sb.Append("load_order_idx INTEGER NOT NULL, ");
        sb.Append("is_winner BOOLEAN NOT NULL DEFAULT FALSE, ");
        sb.Append("editor_id VARCHAR");

        foreach (var col in schema.RecordColumns)
            sb.Append(CultureInfo.InvariantCulture, $", \"{col.Name}\" {col.DuckDbType}");

        Execute(connection, $"CREATE TABLE IF NOT EXISTS \"{schema.TableName}\" ({sb})");
    }

    private static void Execute(DuckDBConnection connection, string sql)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
