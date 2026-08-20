using System.Globalization;
using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Ledger;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

public sealed class TableDdlBuilder(ISchemaReflector reflector) : ITableDdlBuilder
{
    private readonly ISchemaReflector _reflector = reflector;

    public void CreateTables(DuckDBConnection connection, GameRelease release)
    {
        CreateRecordsTable(connection);
        CreatePluginsTable(connection);
        CreateIndexStateTable(connection);
        CreateFormReferencesTable(connection);
        CreateFormLookupTable(connection);
        CreateVmadTables(connection);
        CreateConditionTables(connection);
        CreatePlacementTables(connection);
        foreach (var schema in _reflector.GetSchemas(release).Values)
            CreateRecordTable(connection, schema);
    }

    // ADR-0041 / #413: the documents table — one row per major record, holding that record's codec
    // JSON as its body beside the identity columns the read model is rebuilt on. Replaces the
    // reflected per-type wide tables; the extracted index tables below are populated from these
    // documents at ingest, and the reflector emits json_extract views over this table instead of
    // per-type DDL.
    //
    // `body` is VARCHAR, never DuckDB's JSON type: the JSON type normalizes what it stores, and
    // "the same bytes as the ledger file" is the entire load-bearing claim here — it is what makes
    // `content_hash` a real git object name (GitBlobHash) rather than a hash of some re-rendered
    // equivalent, and what lets a byte compare stand in for dirty/ITM detection later.
    //
    // `ref` (ADR-0041's ref dimension, replacing ADR-0025's committed/staged view split) carries
    // exactly one value in this ticket — see LedgerRef, which explains why it is here now rather
    // than added once #415 gives it a second. Quoted everywhere it appears: REF is a DuckDB keyword.
    //
    // Identity stays (form_key, origin, plugin) per ADR-0036 — no primary key declared, matching
    // every other table here, because indexing writes through appenders and re-index is
    // delete-then-append rather than upsert.
    private static void CreateRecordsTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS records (
                form_key       VARCHAR NOT NULL,
                plugin         VARCHAR NOT NULL,
                origin         VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type    VARCHAR NOT NULL,
                editor_id      VARCHAR,
                load_order_idx INTEGER NOT NULL,
                is_winner      BOOLEAN NOT NULL DEFAULT FALSE,
                "ref"          VARCHAR NOT NULL DEFAULT '{LedgerRef.Committed}',
                body           VARCHAR NOT NULL,
                content_hash   VARCHAR NOT NULL
            )
            """);

        // form_key drives every single-record read (detail, override stack, compare) and the winner
        // sweep's correlated subquery; (plugin, origin) drives the per-plugin delete every re-index
        // starts with, and the per-plugin listings/counts.
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_records_form_key ON records(form_key)
            """);
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_records_plugin ON records(plugin, origin)
            """);
    }

    // #267 / ADR-0035: `participates` is the plugins.txt `*` prefix — the one row per plugin that
    // UpdateWinners()'s per-table sweep joins against so a disabled plugin's row can never win.
    // Populated by DuckDbRecordRepository.Index (one row per indexed plugin), not hand-maintained.
    // #271 / ADR-0036: `origin` (the mod folder that provided this physical file, or a reserved
    // PluginOrigin value) is part of this table's identity alongside `plugin` — two plugins sharing
    // a filename but differing in origin are distinct rows, not a collision.
    private static void CreatePluginsTable(DuckDBConnection connection) =>
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS plugins (
                plugin VARCHAR NOT NULL,
                origin VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                load_order_idx INTEGER NOT NULL,
                is_master BOOLEAN NOT NULL DEFAULT FALSE,
                is_light BOOLEAN NOT NULL DEFAULT FALSE,
                is_writable BOOLEAN NOT NULL DEFAULT FALSE,
                masters VARCHAR[],
                record_count INTEGER,
                file_mtime TIMESTAMP,
                participates BOOLEAN NOT NULL DEFAULT TRUE,
                PRIMARY KEY (plugin, origin)
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
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS form_references (
                source_form_key VARCHAR NOT NULL,
                source_plugin   VARCHAR NOT NULL,
                source_origin   VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
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

    // ADR-0031: global form_key -> (record type, EditorID) lookup, one row per (form_key, plugin)
    // like every reflected record table — populated in the same indexing pass that writes each
    // record's own per-type table row, so CheckErrorBuilder and the compare/changes resolvers can
    // resolve a FormKey in O(1) instead of scanning every per-type table.
    internal static void CreateFormLookupTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS form_lookup (
                form_key       VARCHAR NOT NULL,
                plugin         VARCHAR NOT NULL,
                origin         VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type    VARCHAR NOT NULL,
                editor_id      VARCHAR,
                load_order_idx INTEGER NOT NULL,
                is_winner      BOOLEAN NOT NULL DEFAULT FALSE
            )
            """);
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_form_lookup_form_key
                ON form_lookup(form_key)
            """);
    }

    internal static void CreateVmadTables(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS vmad_scripts (
                form_key     VARCHAR NOT NULL,
                plugin       VARCHAR NOT NULL,
                origin       VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                script_name  VARCHAR NOT NULL,
                script_index INTEGER NOT NULL,
                flags        VARCHAR NOT NULL,
                record_type  VARCHAR NOT NULL
            )
            """);
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_vmad_scripts_fk
                ON vmad_scripts(form_key, plugin, origin)
            """);

        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS vmad_properties (
                form_key       VARCHAR NOT NULL,
                plugin         VARCHAR NOT NULL,
                origin         VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
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
                ON vmad_properties(form_key, plugin, origin)
            """);

        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS vmad_property_list_items (
                form_key        VARCHAR NOT NULL,
                plugin          VARCHAR NOT NULL,
                origin          VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
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
                ON vmad_property_list_items(form_key, plugin, origin)
            """);
    }

    // Conditions (CTDA) index — one `conditions` row per condition, its used parameters spread
    // across `condition_parameters`. Keyed by (form_key, plugin, owner_field_path) so a record can
    // carry conditions on more than one field. Mirrors the VMAD table split so a later editing slice
    // has per-condition / per-parameter addressing without a migration. [ADR-0032]
    internal static void CreateConditionTables(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS conditions (
                form_key         VARCHAR NOT NULL,
                plugin           VARCHAR NOT NULL,
                origin           VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                owner_field_path VARCHAR NOT NULL,
                condition_index  INTEGER NOT NULL,
                record_type      VARCHAR NOT NULL,
                function         VARCHAR NOT NULL,
                operator         VARCHAR NOT NULL,
                is_or            BOOLEAN NOT NULL,
                run_on_target    VARCHAR NOT NULL,
                run_on_reference VARCHAR,
                use_global       BOOLEAN NOT NULL,
                comparison_float FLOAT,
                comparison_global VARCHAR
            )
            """);
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_conditions_fk
                ON conditions(form_key, plugin, origin)
            """);

        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS condition_parameters (
                form_key         VARCHAR NOT NULL,
                plugin           VARCHAR NOT NULL,
                origin           VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                owner_field_path VARCHAR NOT NULL,
                condition_index  INTEGER NOT NULL,
                param_index      INTEGER NOT NULL,
                record_type      VARCHAR NOT NULL,
                category         VARCHAR NOT NULL,
                type_name        VARCHAR NOT NULL,
                number_value     INTEGER,
                formkey_value    VARCHAR,
                text_value       VARCHAR
            )
            """);
        Execute(connection, """
            CREATE INDEX IF NOT EXISTS idx_condition_params_fk
                ON condition_parameters(form_key, plugin, origin)
            """);
    }

    // Phase 16: side tables for the worldspace tree. Parentage is structural (GRUP nesting),
    // so it lives here rather than on the reflected record tables — keeping placement read-only
    // by construction and isolating "move a ref between cells" as a structural op.
    internal static void CreatePlacementTables(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS placement (
                form_key        VARCHAR NOT NULL,
                plugin          VARCHAR NOT NULL,
                origin          VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
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

        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS cell_location (
                cell_form_key    VARCHAR NOT NULL,
                plugin           VARCHAR NOT NULL,
                origin           VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
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

    // #271 / ADR-0036: `origin` is part of every record table's identity alongside `plugin` — the
    // composite key is (form_key, origin, plugin). Placed right after `plugin` (not load-bearing for
    // the explicit-column-list reads in DuckDbRecordRepository, which never SELECT *).
    private static void CreateRecordTable(DuckDBConnection connection, RecordTableSchema schema)
    {
        var sb = new StringBuilder();
        sb.Append("form_key VARCHAR NOT NULL, ");
        sb.Append("plugin VARCHAR NOT NULL, ");
        sb.Append(CultureInfo.InvariantCulture, $"origin VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}', ");
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
