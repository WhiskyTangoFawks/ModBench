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
        CreateFormReferencesTable(connection);
        CreateVmadTables(connection);
        CreatePlacementTables(connection);
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

    internal static void CreateFormReferencesTable(DuckDBConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS form_references (
                source_form_key VARCHAR NOT NULL,
                source_plugin   VARCHAR NOT NULL,
                target_form_key VARCHAR NOT NULL,
                field_path      VARCHAR NOT NULL,
                record_type     VARCHAR NOT NULL,
                editor_id       VARCHAR
            )
            """);
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_form_references_target
                ON form_references(target_form_key)
            """);
    }

    internal static void CreateVmadTables(DuckDBConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS vmad_scripts (
                form_key     VARCHAR NOT NULL,
                plugin       VARCHAR NOT NULL,
                script_name  VARCHAR NOT NULL,
                script_index INTEGER NOT NULL,
                flags        VARCHAR NOT NULL,
                record_type  VARCHAR NOT NULL
            )
            """);
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_vmad_scripts_fk
                ON vmad_scripts(form_key, plugin)
            """);

        Execute(connection, """
            CREATE TABLE IF NOT EXISTS vmad_properties (
                form_key       VARCHAR NOT NULL,
                plugin         VARCHAR NOT NULL,
                script_name    VARCHAR NOT NULL,
                property_name  VARCHAR NOT NULL,
                property_index INTEGER NOT NULL,
                record_type    VARCHAR NOT NULL,
                type           VARCHAR NOT NULL,
                flags          VARCHAR NOT NULL,
                bool_value     BOOLEAN,
                int_value      INTEGER,
                float_value    FLOAT,
                string_value   VARCHAR,
                form_key_value VARCHAR,
                alias_value    SMALLINT,
                struct_json    VARCHAR
            )
            """);
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_vmad_props_fk
                ON vmad_properties(form_key, plugin)
            """);

        Execute(connection, """
            CREATE TABLE IF NOT EXISTS vmad_property_list_items (
                form_key        VARCHAR NOT NULL,
                plugin          VARCHAR NOT NULL,
                script_name     VARCHAR NOT NULL,
                property_name   VARCHAR NOT NULL,
                property_index  INTEGER NOT NULL,
                list_item_index INTEGER NOT NULL,
                record_type     VARCHAR NOT NULL,
                type            VARCHAR NOT NULL,
                bool_value      BOOLEAN,
                int_value       INTEGER,
                float_value     FLOAT,
                string_value    VARCHAR,
                form_key_value  VARCHAR,
                alias_value     SMALLINT
            )
            """);
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_vmad_items_fk
                ON vmad_property_list_items(form_key, plugin)
            """);
    }

    // Phase 16: side tables for the worldspace tree. Parentage is structural (GRUP nesting),
    // so it lives here rather than on the reflected record tables — keeping placement read-only
    // by construction and isolating "move a ref between cells" as a structural op.
    internal static void CreatePlacementTables(DuckDBConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS placement (
                form_key        VARCHAR NOT NULL,
                plugin          VARCHAR NOT NULL,
                parent_cell     VARCHAR NOT NULL,
                placement_group VARCHAR NOT NULL,
                pos_x           FLOAT,
                pos_y           FLOAT,
                pos_z           FLOAT
            )
            """);
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_placement_cell
                ON placement(parent_cell, plugin)
            """);

        Execute(connection, """
            CREATE TABLE IF NOT EXISTS cell_location (
                cell_form_key    VARCHAR NOT NULL,
                plugin           VARCHAR NOT NULL,
                parent_worldspace VARCHAR,
                block_x          INTEGER,
                block_y          INTEGER,
                sub_x            INTEGER,
                sub_y            INTEGER,
                grid_x           INTEGER,
                grid_y           INTEGER,
                is_interior      BOOLEAN NOT NULL DEFAULT FALSE
            )
            """);
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_cell_location_worldspace
                ON cell_location(parent_worldspace, plugin)
            """);
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_cell_location_region
                ON cell_location(parent_worldspace, grid_x, grid_y)
            """);
    }

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
