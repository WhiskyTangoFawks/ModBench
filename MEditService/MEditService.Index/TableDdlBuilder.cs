using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Index;

internal sealed class TableDdlBuilder(SchemaReflector reflector)
{
    private readonly SchemaReflector _reflector = reflector;

    // ADR-0009: `mirror` holds every indexed plugin; `main` holds views of the active
    // plugins. Every writer and every projection read names `mirror.`, and a write against a view
    // fails loudly.
    internal const string MirrorSchema = "mirror";

    // ADR-0012, and Mutagen's ModKey: a FormKey names its plugin by filename, so it
    // compares ignoring case too.
    internal const string FilenameIdentity = "COLLATE NOCASE";

    // A view in `main` over a mirror table carrying a plugin identity: of records, which only the
    // active plugins answer, or of a plugin's own facts, which every registered plugin answers.
    // `registrations` and `mirror.files` have no view.
    private readonly record struct PublicView(
        string Table, string PluginColumn, string OriginColumn, bool HoldsRecords, bool DerivesLoadOrder, bool DerivesWinner);

    // ADR-0009: the views derive `load_order_idx` and `is_winner` by joining
    // `registrations` and `winners`, at Effective. `records_head` joins at Head.
    private static readonly PublicView[] PublicViews =
    [
        new("records", "plugin", "origin", HoldsRecords: true, DerivesLoadOrder: true, DerivesWinner: true),
        new("records_committed", "plugin", "origin", HoldsRecords: true, DerivesLoadOrder: true, DerivesWinner: false),
        new("form_references", "source_plugin", "source_origin", HoldsRecords: true, DerivesLoadOrder: false, DerivesWinner: false),
        new("form_lookup", "plugin", "origin", HoldsRecords: true, DerivesLoadOrder: true, DerivesWinner: true),
        new("placement", "plugin", "origin", HoldsRecords: true, DerivesLoadOrder: false, DerivesWinner: false),
        new("cell_location", "plugin", "origin", HoldsRecords: true, DerivesLoadOrder: false, DerivesWinner: false),
        new("container_child", "plugin", "origin", HoldsRecords: true, DerivesLoadOrder: false, DerivesWinner: false),
        new("record_type_failure", "plugin", "origin", HoldsRecords: false, DerivesLoadOrder: false, DerivesWinner: false),
        new(PluginDerivationTable, "plugin", "origin", HoldsRecords: false, DerivesLoadOrder: false, DerivesWinner: false),
        new(PluginDiagnosisTable, "plugin", "origin", HoldsRecords: false, DerivesLoadOrder: false, DerivesWinner: false),
    ];

    /// <summary>One row per indexed plugin naming which truth its rows came from, its source tree or
    /// its binary: tracked-ness as a row, in the mirror because it is the rows' own fact.</summary>
    internal const string PluginDerivationTable = "plugin_derivation";

    /// <summary>The Kind B diagnoses a plugin's binary proved when it was hashed, one row each, in
    /// record order.</summary>
    internal const string PluginDiagnosisTable = "plugin_diagnosis";

    /// <summary>The winners relation, bare — no schema prefix — because it is load-order-derived
    /// state, not a file mirror: it lives in <c>main</c> beside <c>registrations</c>.</summary>
    internal const string WinnersRelation = "winners";

    /// <summary>One row per plugin the snapshot names, carrying its load index, null when it is not
    /// active (ADR-0013). Every public view joins it.</summary>
    internal const string RegistrationsRelation = "registrations";

    /// <summary>The active plugins with their load index (ADR-0013), which the sweep
    /// orders by. Load-order-owned state, so it lives in <c>main</c>.</summary>
    internal const string ActiveRelation = "active_plugins";

    // A LEFT JOIN, never a correlated EXISTS: winners holds at most one row per (ref, form_key), so
    // the join cannot duplicate a row, and a hash join beats EXISTS on the full-scan reads that
    // dominate.
    private static string WinnerJoin(string alias, RecordRef @ref, string pluginColumn, string originColumn) => $"""
        LEFT JOIN {WinnersRelation} w
               ON w.record_ref = '{WinnerRef.Of(@ref)}'
              AND w.form_key = {alias}.form_key
              AND w.plugin = {alias}.{pluginColumn}
              AND w.origin = {alias}.{originColumn}
        """;

    public static void CreateTables(DuckDBConnection connection)
    {
        Execute(connection, $"CREATE SCHEMA IF NOT EXISTS {MirrorSchema}");
        CreateRecordsTable(connection);
        CreateRegistrationsTable(connection);
        CreateActiveTable(connection);
        CreateWinnersTable(connection);
        CreateCommittedRecordsTable(connection);
        CreateFilesTable(connection);
        CreatePluginDerivationTable(connection);
        CreatePluginDiagnosisTable(connection);
        CreateFormReferencesTable(connection);
        CreateFormLookupTable(connection);
        CreatePlacementTables(connection);
        CreateContainerChildTable(connection);
        CreateRecordTypeFailureTable(connection);
        CreateSequenceTable(connection);
        Execute(connection, $"CREATE TABLE IF NOT EXISTS {MirrorSchema}.index_version (value VARCHAR NOT NULL)");

        // Views after tables: the public views over every mirror table, then the Head views.
        CreatePublicViews(connection);
        CreateHeadView(connection);
    }

    // ADR-0015: a plain table, not DuckDB's SEQUENCE — nextval() is not transactional,
    // and this count must roll back with the rows it describes. The seed is a no-op past the first
    // open.
    private static void CreateSequenceTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.sequence (
                value BIGINT NOT NULL
            )
            """);
        Execute(connection, $"""
            INSERT INTO {MirrorSchema}.sequence (value)
            SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM {MirrorSchema}.sequence)
            """);
    }

    // ADR-0011, header included.
    public void CreateRecordTypeViews(DuckDBConnection connection, GameRelease release) =>
        RecordViewBuilder.CreateViews(connection, _reflector.GetSchemas(release));

    /// <summary>A plugin's own facts answer while the snapshot names it.</summary>
    internal static string RegisteredJoin(string alias, string pluginColumn, string originColumn) => $"""
        JOIN {RegistrationsRelation} p ON p.plugin = {alias}.{pluginColumn} AND p.origin = {alias}.{originColumn}
        """;

    // ADR-0009, through this one predicate. A registration's load index is null when
    // the plugin is not active (ADR-0013).
    private static string ActiveJoin(string alias, string pluginColumn, string originColumn) =>
        $"{RegisteredJoin(alias, pluginColumn, originColumn)} AND p.load_order_idx IS NOT NULL";

    private static void CreatePublicViews(DuckDBConnection connection)
    {
        foreach (var relation in PublicViews)
        {
            var scope = relation.HoldsRecords
                ? ActiveJoin("t", relation.PluginColumn, relation.OriginColumn)
                : RegisteredJoin("t", relation.PluginColumn, relation.OriginColumn);
            var loadOrderColumn = relation.DerivesLoadOrder ? ", p.load_order_idx" : "";
            var winnerColumn = relation.DerivesWinner ? ", (w.form_key IS NOT NULL) AS is_winner" : "";
            var winnerJoin = relation.DerivesWinner
                ? WinnerJoin("t", RecordRef.Effective, relation.PluginColumn, relation.OriginColumn)
                : "";
            Execute(connection, $"""
                CREATE OR REPLACE VIEW "{relation.Table}" AS
                SELECT t.*{loadOrderColumn}{winnerColumn}
                FROM {MirrorSchema}."{relation.Table}" t
                {scope}
                {winnerJoin}
                """);
        }
    }

    // `body` is VARCHAR, never DuckDB's JSON type, which normalizes what it stores: "the same bytes
    // as the source file" is what makes content_hash a real git object name. `ref` is quoted
    // everywhere: REF is a DuckDB keyword.
    private static void CreateRecordsTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.records (
                form_key        VARCHAR {FilenameIdentity} NOT NULL,
                plugin          VARCHAR {FilenameIdentity} NOT NULL,
                origin          VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type     VARCHAR NOT NULL,
                editor_id       VARCHAR,
                "ref"           VARCHAR NOT NULL DEFAULT '{SourceRef.Committed}',
                body            VARCHAR NOT NULL,
                content_hash    VARCHAR NOT NULL,
                parse_diagnosis VARCHAR
            )
            """);

        // form_key drives every single-record read; (plugin, origin) drives the per-plugin delete
        // every re-index starts with, and the per-plugin listings/counts.
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_records_form_key ON {MirrorSchema}.records(form_key)
            """);
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_records_plugin ON {MirrorSchema}.records(plugin, origin)
            """);
    }

    // The committed half of the ref dimension: only the snapshot of a record whose working tree
    // diverged, nothing for the clean majority. A column-for-column mirror of `records` so
    // `records_head` is a plain UNION ALL of one shape.
    private static void CreateCommittedRecordsTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.records_committed (
                form_key        VARCHAR {FilenameIdentity} NOT NULL,
                plugin          VARCHAR {FilenameIdentity} NOT NULL,
                origin          VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type     VARCHAR NOT NULL,
                editor_id       VARCHAR,
                "ref"           VARCHAR NOT NULL DEFAULT '{SourceRef.Committed}',
                body            VARCHAR NOT NULL,
                content_hash    VARCHAR NOT NULL,
                parse_diagnosis VARCHAR
            )
            """);

        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_records_committed_form_key ON {MirrorSchema}.records_committed(form_key)
            """);
    }

    /// <summary>What Head holds, for every indexed plugin, with no winner column. Outside the SQL
    /// door: the winner sweep, the projection and <c>records_head</c> read this one
    /// definition.</summary>
    internal const string HeadRowsRelation = $"{MirrorSchema}.head_rows";

    private static void CreateHeadView(DuckDBConnection connection)
    {
        // Disjoint halves by construction (the snapshot write and the `ref` flip share one
        // transaction), so UNION ALL is exact.
        Execute(connection, $"""
            CREATE OR REPLACE VIEW {HeadRowsRelation} AS
            SELECT form_key, plugin, origin, record_type, editor_id, "ref", body, content_hash, parse_diagnosis
            FROM {MirrorSchema}.records_committed
            UNION ALL
            SELECT form_key, plugin, origin, record_type, editor_id, "ref", body, content_hash, parse_diagnosis
            FROM {MirrorSchema}.records WHERE "ref" = '{SourceRef.Committed}'
            """);

        // is_winner is Head's own answer, never Effective's carried through: a working-tree delete
        // promotes the next plugin at Effective through a clean row this view shares, so reusing
        // Effective's winner would report two winners at Head.
        Execute(connection, $"""
            CREATE OR REPLACE VIEW records_head AS
            SELECT h.form_key, h.plugin, h.origin, h.record_type, h.editor_id, p.load_order_idx,
                   (w.form_key IS NOT NULL) AS is_winner,
                   h."ref", h.body, h.content_hash, h.parse_diagnosis
            FROM {HeadRowsRelation} h
            {ActiveJoin("h", "plugin", "origin")}
            {WinnerJoin("h", RecordRef.Head, "plugin", "origin")}
            """);
    }

    // Replaced whole by each sweep, never diffed (ADR-0013), and remembered for
    // the re-sweeps a working-tree write triggers.
    private static void CreateActiveTable(DuckDBConnection connection) =>
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {ActiveRelation} (
                plugin VARCHAR {FilenameIdentity} NOT NULL,
                origin VARCHAR {FilenameIdentity} NOT NULL,
                load_order_idx INTEGER NOT NULL,
                PRIMARY KEY (plugin, origin)
            )
            """);

    // No PRIMARY KEY on any appended table: re-index is delete-then-append, and the ART index across
    // the rebuild measured 6x the sweep.
    private static void CreateWinnersTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {WinnersRelation} (
                record_ref VARCHAR NOT NULL,
                form_key   VARCHAR {FilenameIdentity} NOT NULL,
                plugin     VARCHAR {FilenameIdentity} NOT NULL,
                origin     VARCHAR {FilenameIdentity} NOT NULL
            )
            """);
    }

    // ADR-0013: one row per plugin file, carrying its load index, null when it is not active.
    // Not cleared at open (ADR-0013).
    private static void CreateRegistrationsTable(DuckDBConnection connection) =>
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {RegistrationsRelation} (
                plugin VARCHAR {FilenameIdentity} NOT NULL,
                origin VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                load_order_idx INTEGER,
                is_light BOOLEAN NOT NULL,
                PRIMARY KEY (plugin, origin)
            )
            """);

    /// <summary>ADR-0009: what the index believes is on disk. Apart from
    /// <c>registrations</c>, whose rows come and go with every reconcile, so the first unregister (a
    /// profile switch) keeps the hash.</summary>
    internal static void CreateFilesTable(DuckDBConnection connection) =>
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.files (
                plugin        VARCHAR {FilenameIdentity} NOT NULL,
                origin        VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                file_path     VARCHAR NOT NULL,
                content_hash  VARCHAR NOT NULL,
                PRIMARY KEY (plugin, origin)
            )
            """);

    internal static void CreatePluginDerivationTable(DuckDBConnection connection) =>
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.{PluginDerivationTable} (
                plugin       VARCHAR {FilenameIdentity} NOT NULL,
                origin       VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                derived_from VARCHAR NOT NULL,
                PRIMARY KEY (plugin, origin)
            )
            """);

    internal static void CreatePluginDiagnosisTable(DuckDBConnection connection) =>
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.{PluginDiagnosisTable} (
                plugin       VARCHAR {FilenameIdentity} NOT NULL,
                origin       VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                ordinal      INTEGER NOT NULL,
                anchor       VARCHAR,
                defect_class VARCHAR NOT NULL,
                tail         VARCHAR,
                message      VARCHAR NOT NULL
            )
            """);

    internal static void CreateFormReferencesTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.form_references (
                source_form_key VARCHAR {FilenameIdentity} NOT NULL,
                source_plugin   VARCHAR {FilenameIdentity} NOT NULL,
                source_origin   VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                target_form_key VARCHAR {FilenameIdentity} NOT NULL,
                field_path      VARCHAR NOT NULL,
                record_type     VARCHAR NOT NULL,
                editor_id       VARCHAR
            )
            """);
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_form_references_target
                ON {MirrorSchema}.form_references(target_form_key)
            """);
    }

    // The form lookup ADR-0011 extracts at ingest: form_key -> (record type, EditorID). One row per
    // (form_key, plugin), so CheckErrorBuilder and the compare resolvers resolve a FormKey in O(1).
    internal static void CreateFormLookupTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.form_lookup (
                form_key       VARCHAR {FilenameIdentity} NOT NULL,
                plugin         VARCHAR {FilenameIdentity} NOT NULL,
                origin         VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type    VARCHAR NOT NULL,
                editor_id      VARCHAR
            )
            """);
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_form_lookup_form_key
                ON {MirrorSchema}.form_lookup(form_key)
            """);
    }

    // ADR-0011: side tables for the worldspace tree. Parentage is structural (GRUP nesting), so it
    // lives here rather than in the record document, keeping placement read-only by construction.
    internal static void CreatePlacementTables(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.placement (
                form_key        VARCHAR {FilenameIdentity} NOT NULL,
                plugin          VARCHAR {FilenameIdentity} NOT NULL,
                origin          VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                parent_cell     VARCHAR {FilenameIdentity} NOT NULL,
                placement_group VARCHAR NOT NULL,
                pos_x           FLOAT,
                pos_y           FLOAT,
                pos_z           FLOAT
            )
            """);
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_placement_cell
                ON {MirrorSchema}.placement(parent_cell, plugin)
            """);

        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.cell_location (
                cell_form_key    VARCHAR {FilenameIdentity} NOT NULL,
                plugin           VARCHAR {FilenameIdentity} NOT NULL,
                origin           VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                parent_worldspace VARCHAR {FilenameIdentity},
                block_x          INTEGER,
                block_y          INTEGER,
                sub_x            INTEGER,
                sub_y            INTEGER,
                grid_x           INTEGER,
                grid_y           INTEGER,
                is_interior      BOOLEAN NOT NULL DEFAULT FALSE
            )
            """);
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_cell_location_worldspace
                ON {MirrorSchema}.cell_location(parent_worldspace, plugin)
            """);
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_cell_location_region
                ON {MirrorSchema}.cell_location(parent_worldspace, grid_x, grid_y)
            """);
    }

    // The ContainerChildFields relationships placement/cell_location don't already carry — additive
    // to the tables above, never a replacement for what they already cover.
    internal static void CreateContainerChildTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.container_child (
                child_form_key      VARCHAR {FilenameIdentity} NOT NULL,
                plugin               VARCHAR {FilenameIdentity} NOT NULL,
                origin               VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                parent_form_key      VARCHAR {FilenameIdentity} NOT NULL,
                parent_record_type   VARCHAR NOT NULL,
                slot_name            VARCHAR NOT NULL,
                slot_index           INTEGER NOT NULL
            )
            """);
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_container_child_parent
                ON {MirrorSchema}.container_child(parent_form_key, plugin)
            """);
    }

    // A whole record type Mutagen could not finish enumerating: there is no record row to carry the
    // status, because the records it would have carried are the ones that never arrived.
    internal static void CreateRecordTypeFailureTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.record_type_failure (
                plugin          VARCHAR {FilenameIdentity} NOT NULL,
                origin          VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type     VARCHAR NOT NULL,
                parse_diagnosis VARCHAR NOT NULL
            )
            """);
    }

    private static void Execute(DuckDBConnection connection, string sql)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
