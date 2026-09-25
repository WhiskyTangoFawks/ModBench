using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Index;

internal sealed class TableDdlBuilder(SchemaReflector reflector)
{
    private readonly SchemaReflector _reflector = reflector;

    // ADR-0009: physical tables live in `mirror`; the public names in `main` are views scoped by
    // registration. Every writer names `mirror.` explicitly, and a write against a view fails
    // loudly, so the database enforces the split.
    internal const string MirrorSchema = "mirror";

    // A mirror table carrying a plugin identity, plus which load-order-derived columns its view
    // adds. `registrations` is the registration itself; `mirror.files` must answer for plugins the
    // load order does not register, so neither appears below.
    private readonly record struct RegisteredRelation(
        string Table, string PluginColumn, string OriginColumn, bool DerivesLoadOrder, bool DerivesWinner);

    // ADR-0009: `load_order_idx` and `is_winner` live on no mirror table — one is a fact about the
    // registration, the other about the registered stack — so the views derive them by joining
    // `registrations` and `winners`, at Effective. `records_head` joins at Head.
    private static readonly RegisteredRelation[] RegisteredRelations =
    [
        new("records", "plugin", "origin", DerivesLoadOrder: true, DerivesWinner: true),
        new("records_committed", "plugin", "origin", DerivesLoadOrder: true, DerivesWinner: false),
        new("form_references", "source_plugin", "source_origin", DerivesLoadOrder: false, DerivesWinner: false),
        new("form_lookup", "plugin", "origin", DerivesLoadOrder: true, DerivesWinner: true),
        new("placement", "plugin", "origin", DerivesLoadOrder: false, DerivesWinner: false),
        new("cell_location", "plugin", "origin", DerivesLoadOrder: false, DerivesWinner: false),
        new("container_child", "plugin", "origin", DerivesLoadOrder: false, DerivesWinner: false),
        new("record_type_failure", "plugin", "origin", DerivesLoadOrder: false, DerivesWinner: false),
        new(PluginDerivationTable, "plugin", "origin", DerivesLoadOrder: false, DerivesWinner: false),
        new(PluginDiagnosisTable, "plugin", "origin", DerivesLoadOrder: false, DerivesWinner: false),
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

    /// <summary>One row per plugin file the load order holds, carrying ADR-0013's three
    /// facts. Registration is visibility (ADR-0009): every registered view joins it. Participation
    /// is never a column here.</summary>
    internal const string RegistrationsRelation = "registrations";

    /// <summary>ADR-0013: who competes for winner, as the load order value answered it, with each
    /// plugin's slot so the sweep can order by it. Load-order-owned state, so it lives in
    /// <c>main</c>.</summary>
    internal const string ParticipatingRelation = "participating";

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
        CreateParticipatingTable(connection);
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

        // Views after tables, in dependency order: the registered views over every mirror table, then
        // the Head views over the registered `records`/`records_committed`.
        CreateRegisteredViews(connection);
        CreateHeadView(connection);
    }

    // ADR-0015 invariant 3: a plain table, not DuckDB's SEQUENCE — nextval() is not transactional,
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

    // ADR-0007: one json_extract VIEW over the registered `records` per record type, header included.
    // Apart from CreateTables because only user filter SQL reads them (ADR-0011).
    public void CreateRecordTypeViews(DuckDBConnection connection, GameRelease release) =>
        RecordViewBuilder.CreateViews(connection, _reflector.GetSchemas(release));

    // ADR-0009: the one "registered" predicate — a row answers iff a registrations row names its
    // (plugin, origin) — so C# reads and the SQL door cannot scope differently. Registered, not
    // participating: an overridden or disabled plugin stays visible (ADR-0013).
    private static void CreateRegisteredViews(DuckDBConnection connection)
    {
        foreach (var relation in RegisteredRelations)
        {
            var loadOrderColumn = relation.DerivesLoadOrder ? ", p.load_order_idx" : "";
            var winnerColumn = relation.DerivesWinner ? ", (w.form_key IS NOT NULL) AS is_winner" : "";
            var winnerJoin = relation.DerivesWinner
                ? WinnerJoin("t", RecordRef.Effective, relation.PluginColumn, relation.OriginColumn)
                : "";
            Execute(connection, $"""
                CREATE OR REPLACE VIEW "{relation.Table}" AS
                SELECT t.*{loadOrderColumn}{winnerColumn}
                FROM {MirrorSchema}."{relation.Table}" t
                JOIN {RegistrationsRelation} p ON p.plugin = t.{relation.PluginColumn} AND p.origin = t.{relation.OriginColumn}
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
                form_key        VARCHAR NOT NULL,
                plugin          VARCHAR NOT NULL,
                origin          VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
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
                form_key        VARCHAR NOT NULL,
                plugin          VARCHAR NOT NULL,
                origin          VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
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

    /// <summary>The Head membership relation, with no winner column. In the mirror schema because it
    /// is not part of the SQL door: it exists so the winner sweep and <c>records_head</c> read one
    /// definition of "what Head holds".</summary>
    internal const string HeadRowsRelation = $"{MirrorSchema}.head_rows";

    // Reads the registered `records`/`records_committed` views, not the mirror tables, so Head
    // is scoped by registration through the same predicate as Effective.
    private static void CreateHeadView(DuckDBConnection connection)
    {
        // Disjoint halves by construction (the snapshot write and the `ref` flip share one
        // transaction), so UNION ALL is exact. Both halves name `main.` explicitly: this view lives
        // in `mirror`, where an unqualified `records` is the unscoped mirror table.
        Execute(connection, $"""
            CREATE OR REPLACE VIEW {HeadRowsRelation} AS
            SELECT form_key, plugin, origin, record_type, editor_id, load_order_idx, "ref", body, content_hash, parse_diagnosis
            FROM main.records_committed
            UNION ALL
            SELECT form_key, plugin, origin, record_type, editor_id, load_order_idx, "ref", body, content_hash, parse_diagnosis
            FROM main.records WHERE "ref" = '{SourceRef.Committed}'
            """);

        // is_winner is Head's own answer, never Effective's carried through: a working-tree delete
        // promotes the next plugin at Effective through a clean row this view shares, so reusing
        // Effective's winner would report two winners at Head.
        Execute(connection, $"""
            CREATE OR REPLACE VIEW records_head AS
            SELECT h.form_key, h.plugin, h.origin, h.record_type, h.editor_id, h.load_order_idx,
                   (w.form_key IS NOT NULL) AS is_winner,
                   h."ref", h.body, h.content_hash, h.parse_diagnosis
            FROM {HeadRowsRelation} h
            {WinnerJoin("h", RecordRef.Head, "plugin", "origin")}
            """);
    }

    // ADR-0013: replaced whole by each sweep, never diffed — the load order value decides who is in
    // it, and this table only remembers the answer for the re-sweeps a working-tree write triggers.
    private static void CreateParticipatingTable(DuckDBConnection connection) =>
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {ParticipatingRelation} (
                plugin VARCHAR NOT NULL,
                origin VARCHAR NOT NULL,
                load_order_idx INTEGER NOT NULL,
                PRIMARY KEY (plugin, origin)
            )
            """);

    // ADR-0009: winning is a function of registration alone. No PRIMARY KEY on any appended table:
    // re-index is delete-then-append, and the ART index across the rebuild measured 6x the sweep.
    private static void CreateWinnersTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {WinnersRelation} (
                record_ref VARCHAR NOT NULL,
                form_key   VARCHAR NOT NULL,
                plugin     VARCHAR NOT NULL,
                origin     VARCHAR NOT NULL
            )
            """);
    }

    // ADR-0013: one row per plugin file, carrying the three facts participation derives
    // from; participation itself is never a column here. ADR-0009: not cleared at open — the first
    // reconcile corrects these rows.
    private static void CreateRegistrationsTable(DuckDBConnection connection) =>
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {RegistrationsRelation} (
                plugin VARCHAR NOT NULL,
                origin VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                load_order_idx INTEGER,
                enabled BOOLEAN NOT NULL,
                winning BOOLEAN NOT NULL,
                PRIMARY KEY (plugin, origin)
            )
            """);

    /// <summary>ADR-0009: what the index believes is on disk. Separate from <c>registrations</c>:
    /// those rows come and go with every reconcile, and storing the hash there would lose it at
    /// the first unregister (a profile switch).</summary>
    internal static void CreateFilesTable(DuckDBConnection connection) =>
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.files (
                plugin        VARCHAR NOT NULL,
                origin        VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                file_path     VARCHAR NOT NULL,
                content_hash  VARCHAR NOT NULL,
                index_version VARCHAR NOT NULL,
                PRIMARY KEY (plugin, origin)
            )
            """);

    internal static void CreatePluginDerivationTable(DuckDBConnection connection) =>
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.{PluginDerivationTable} (
                plugin       VARCHAR NOT NULL,
                origin       VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                derived_from VARCHAR NOT NULL,
                PRIMARY KEY (plugin, origin)
            )
            """);

    internal static void CreatePluginDiagnosisTable(DuckDBConnection connection) =>
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.{PluginDiagnosisTable} (
                plugin       VARCHAR NOT NULL,
                origin       VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
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
                source_form_key VARCHAR NOT NULL,
                source_plugin   VARCHAR NOT NULL,
                source_origin   VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                target_form_key VARCHAR NOT NULL,
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

    // ADR-0005: global form_key -> (record type, EditorID) lookup, one row per (form_key, plugin),
    // extracted in the same ingest pass that writes the `records` row, so CheckErrorBuilder and the
    // compare resolvers resolve a FormKey in O(1).
    internal static void CreateFormLookupTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.form_lookup (
                form_key       VARCHAR NOT NULL,
                plugin         VARCHAR NOT NULL,
                origin         VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type    VARCHAR NOT NULL,
                editor_id      VARCHAR
            )
            """);
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_form_lookup_form_key
                ON {MirrorSchema}.form_lookup(form_key)
            """);
    }

    // ADR-0005: side tables for the worldspace tree. Parentage is structural (GRUP nesting), so it
    // lives here rather than in the record document, keeping placement read-only by construction.
    internal static void CreatePlacementTables(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.placement (
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
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_placement_cell
                ON {MirrorSchema}.placement(parent_cell, plugin)
            """);

        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.cell_location (
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
                child_form_key      VARCHAR NOT NULL,
                plugin               VARCHAR NOT NULL,
                origin               VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                parent_form_key      VARCHAR NOT NULL,
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
                plugin          VARCHAR NOT NULL,
                origin          VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
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
