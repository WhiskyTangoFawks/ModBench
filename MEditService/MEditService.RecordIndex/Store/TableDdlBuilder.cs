using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex.Store;

internal sealed class TableDdlBuilder(SchemaReflector reflector)
{
    private readonly SchemaReflector _reflector = reflector;

    // ADR-0012: `mirror` holds every indexed plugin; `main` holds views over it. Every writer and
    // every projection read names `mirror.`, and a write against a view fails loudly.
    internal const string MirrorSchema = "mirror";

    internal const string ActiveSchema = "main";

    /// <summary>The views a SELECT reads: the records of every plugin the record index holds, each row saying whether
    /// its plugin is active. A connection that reads them takes this schema as its search path.</summary>
    internal const string IndexedSchema = "indexed";

    internal const string ViewColumnsView = "view_columns";

    /// <summary>The views both schemas hold whatever the game; each record type has a view of its own besides.</summary>
    internal static IEnumerable<string> FixedViews => PublicViews.Select(view => view.Table).Append("form_lookup");

    // ADR-0012, and Mutagen's ModKey: a FormKey names its plugin by filename, so it
    // compares ignoring case too.
    internal const string FilenameIdentity = "COLLATE NOCASE";

    // A view over a mirror table carrying a plugin identity: of records, which only the
    // active plugins answer, or of a plugin's own facts, which every registered plugin answers.
    // `registrations` and `mirror.files` have no view.
    private readonly record struct PublicView(
        string Table, string PluginColumn, string OriginColumn, bool HoldsRecords, bool DerivesLoadOrder, bool DerivesWinner);

    // ADR-0012: the views derive `load_order_idx` and `is_winner` by joining
    // `registrations` and `winners`.
    private static readonly PublicView[] PublicViews =
    [
        new("records", "plugin", "origin", HoldsRecords: true, DerivesLoadOrder: true, DerivesWinner: true),
        new("form_references", "source_plugin", "source_origin", HoldsRecords: true, DerivesLoadOrder: false, DerivesWinner: false),
        new("holdings", "plugin", "origin", HoldsRecords: true, DerivesLoadOrder: false, DerivesWinner: false),
        new("cell_location", "plugin", "origin", HoldsRecords: true, DerivesLoadOrder: false, DerivesWinner: false),
        new("record_type_failure", "plugin", "origin", HoldsRecords: false, DerivesLoadOrder: false, DerivesWinner: false),
        new(PluginDerivationTable, "plugin", "origin", HoldsRecords: false, DerivesLoadOrder: false, DerivesWinner: false),
        new(PluginDiagnosisTable, "plugin", "origin", HoldsRecords: false, DerivesLoadOrder: false, DerivesWinner: false),
    ];

    /// <summary>Every mirror table that names a plugin, with the columns that do.</summary>
    internal static IEnumerable<(string Relation, string PluginColumn, string OriginColumn)> MirroredPluginNames =>
        PublicViews
            .Select(view => ($"{MirrorSchema}.\"{view.Table}\"", view.PluginColumn, view.OriginColumn))
            .Append(($"{MirrorSchema}.files", "plugin", "origin"));

    /// <summary>One row per indexed plugin naming which truth its rows came from, its source tree or
    /// its binary: being a compiled plugin as a row, in the mirror because it is the rows' own fact.</summary>
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
    internal const string StringsLanguageRelation = MirrorSchema + ".strings_language";

    /// <summary>The active plugins with their load index (ADR-0013), which the sweep
    /// orders by. Load-order-owned state, so it lives in <c>main</c>.</summary>
    internal const string ActiveRelation = "active_plugins";

    // A LEFT JOIN, never a correlated EXISTS: winners holds at most one row per form_key, so
    // the join cannot duplicate a row, and a hash join beats EXISTS on the full-scan reads that
    // dominate.
    internal static string WinnerJoin(string alias, string pluginColumn, string originColumn) => $"""
        LEFT JOIN {ActiveSchema}.{WinnersRelation} w
               ON w.form_key = {alias}.form_key
              AND w.plugin = {alias}.{pluginColumn}
              AND w.origin = {alias}.{originColumn}
        """;

    // The tables a plugin's rows land in (records, winners, form_references, holdings) take no key or
    // index: DuckDB serves no NOCASE lookup from one, and a re-read's commit pins their entries in memory.
    public static void CreateTables(DuckDBConnection connection)
    {
        DuckDbSql.Execute(connection, $"CREATE SCHEMA IF NOT EXISTS {MirrorSchema}");
        DuckDbSql.Execute(connection, $"CREATE SCHEMA IF NOT EXISTS {IndexedSchema}");
        CreateRecordsTable(connection);
        CreateRegistrationsTable(connection);
        CreateActiveTable(connection);
        CreateWinnersTable(connection);
        CreateFilesTable(connection);
        CreatePluginDerivationTable(connection);
        CreatePluginDiagnosisTable(connection);
        CreateFormReferencesTable(connection);
        CreateHoldingsTable(connection);
        CreateCellLocationTable(connection);
        CreateRecordTypeFailureTable(connection);
        CreateSequenceTable(connection);
        CreateStringsLanguageTable(connection);
        DuckDbSql.Execute(connection, $"CREATE TABLE IF NOT EXISTS {MirrorSchema}.index_version (value VARCHAR NOT NULL)");

        // Views after tables: the public views over every mirror table.
        CreatePublicViews(connection);
    }

    private static void CreateStringsLanguageTable(DuckDBConnection connection)
    {
        DuckDbSql.Execute(connection, $"CREATE TABLE IF NOT EXISTS {StringsLanguageRelation} (language VARCHAR NOT NULL)");
        DuckDbSql.Execute(connection, $"INSERT INTO {StringsLanguageRelation} SELECT '{Language.English}' WHERE NOT EXISTS (SELECT 1 FROM {StringsLanguageRelation})");
    }

    // ADR-0015: a plain table, not DuckDB's SEQUENCE — nextval() is not transactional,
    // and this count must roll back with the rows it describes. The seed is a no-op past the first
    // open.
    private static void CreateSequenceTable(DuckDBConnection connection)
    {
        DuckDbSql.Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.sequence (
                value BIGINT NOT NULL
            )
            """);
        DuckDbSql.Execute(connection, $"""
            INSERT INTO {MirrorSchema}.sequence (value)
            SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM {MirrorSchema}.sequence)
            """);
    }

    public void CreateRecordTypeViews(DuckDBConnection connection, GameRelease release) =>
        RecordViewBuilder.CreateViews(connection, _reflector.GetSchemas(release));

    /// <summary>A plugin's own facts answer while the snapshot names it.</summary>
    internal static string RegisteredJoin(string alias, string pluginColumn, string originColumn) => $"""
        JOIN {ActiveSchema}.{RegistrationsRelation} p ON p.plugin = {alias}.{pluginColumn} AND p.origin = {alias}.{originColumn}
        """;

    // ADR-0012, through this one predicate. A registration's load index is null when
    // the plugin is not active (ADR-0013).
    internal static string ActiveJoin(string alias, string pluginColumn, string originColumn) =>
        $"{RegisteredJoin(alias, pluginColumn, originColumn)} AND p.load_order_idx IS NOT NULL";

    internal const string PluginRecordsView = "plugin_records";

    private static void CreatePublicViews(DuckDBConnection connection)
    {
        foreach (var relation in PublicViews)
        {
            CreatePublicView(connection, ActiveSchema, relation.Table, relation, relation.HoldsRecords
                ? ActiveJoin("t", relation.PluginColumn, relation.OriginColumn)
                : RegisteredJoin("t", relation.PluginColumn, relation.OriginColumn));
            CreatePublicView(connection, IndexedSchema, relation.Table, relation,
                RegisteredJoin("t", relation.PluginColumn, relation.OriginColumn));
        }

        var records = PublicViews.Single(relation => relation.Table == "records");
        CreatePublicView(connection, ActiveSchema, PluginRecordsView, records, RegisteredJoin("t", records.PluginColumn, records.OriginColumn));

        // form_key -> (record type, EditorID): the lookup exposes records' identity columns, not its
        // document.
        const string lookupColumns = "t.form_key, t.plugin, t.origin, t.record_type, t.editor_id";
        CreatePublicView(
            connection, ActiveSchema, "form_lookup", records, ActiveJoin("t", records.PluginColumn, records.OriginColumn), lookupColumns);
        CreatePublicView(
            connection, IndexedSchema, "form_lookup", records, RegisteredJoin("t", records.PluginColumn, records.OriginColumn), lookupColumns);

        DuckDbSql.Execute(connection, $"""
            CREATE OR REPLACE VIEW {IndexedSchema}.{ViewColumnsView} AS
            SELECT table_name AS view_name, column_name, data_type
            FROM information_schema.columns
            WHERE table_catalog = current_database() AND table_schema = '{IndexedSchema}' AND table_name <> '{ViewColumnsView}'
            ORDER BY table_name, ordinal_position
            """);
    }

    private static void CreatePublicView(
        DuckDBConnection connection, string schema, string view, PublicView relation, string scope, string columns = "t.*")
    {
        var loadOrderColumn = relation.DerivesLoadOrder ? ", p.load_order_idx" : "";
        var winnerColumn = relation.DerivesWinner ? ", (w.form_key IS NOT NULL) AS is_winner" : "";
        var activeColumn = schema == IndexedSchema ? ", (p.load_order_idx IS NOT NULL) AS is_active" : "";
        var winnerJoin = relation.DerivesWinner
            ? WinnerJoin("t", relation.PluginColumn, relation.OriginColumn)
            : "";
        DuckDbSql.Execute(connection, $"""
            CREATE OR REPLACE VIEW {schema}."{view}" AS
            SELECT {columns}{loadOrderColumn}{winnerColumn}{activeColumn}
            FROM {MirrorSchema}."{relation.Table}" t
            {scope}
            {winnerJoin}
            """);
    }

    // `body` is VARCHAR, never DuckDB's JSON type, which normalizes what it stores: "the same bytes
    // as the source file" is what lets content_hash stamp them.
    private static void CreateRecordsTable(DuckDBConnection connection) =>
        DuckDbSql.Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.records (
                form_key        VARCHAR {FilenameIdentity} NOT NULL,
                plugin          VARCHAR {FilenameIdentity} NOT NULL,
                origin          VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type     VARCHAR NOT NULL,
                editor_id       VARCHAR,
                working_tree_state VARCHAR NOT NULL DEFAULT '{WorkingTreeState.None.Stored()}',
                body            VARCHAR NOT NULL,
                content_hash    VARCHAR NOT NULL,
                parse_diagnosis VARCHAR,
                masters         VARCHAR[] NOT NULL DEFAULT [],
                form_key_plugin VARCHAR {FilenameIdentity}
            )
            """);

    // Replaced whole by each sweep, never diffed (ADR-0013), and remembered for
    // the re-sweeps a working-tree write triggers.
    private static void CreateActiveTable(DuckDBConnection connection) =>
        DuckDbSql.Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {ActiveRelation} (
                plugin VARCHAR {FilenameIdentity} NOT NULL,
                origin VARCHAR {FilenameIdentity} NOT NULL,
                load_order_idx INTEGER NOT NULL,
                PRIMARY KEY (plugin, origin)
            )
            """);

    private static void CreateWinnersTable(DuckDBConnection connection)
    {
        DuckDbSql.Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {WinnersRelation} (
                form_key   VARCHAR {FilenameIdentity} NOT NULL,
                plugin     VARCHAR {FilenameIdentity} NOT NULL,
                origin     VARCHAR {FilenameIdentity} NOT NULL
            )
            """);
    }

    private static void CreateRegistrationsTable(DuckDBConnection connection) =>
        DuckDbSql.Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {RegistrationsRelation} (
                plugin VARCHAR {FilenameIdentity} NOT NULL,
                origin VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                load_order_idx INTEGER,
                is_light BOOLEAN NOT NULL,
                PRIMARY KEY (plugin, origin)
            )
            """);

    /// <summary>ADR-0003: what the record index believes is on disk. Apart from
    /// <c>registrations</c>, whose rows come and go with every reconcile, so the first unregister (a
    /// profile switch) keeps the hash.</summary>
    internal static void CreateFilesTable(DuckDBConnection connection) =>
        DuckDbSql.Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.files (
                plugin        VARCHAR {FilenameIdentity} NOT NULL,
                origin        VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                file_path     VARCHAR NOT NULL,
                content_hash  VARCHAR NOT NULL,
                strings_read  VARCHAR,
                PRIMARY KEY (plugin, origin)
            )
            """);

    internal static void CreatePluginDerivationTable(DuckDBConnection connection) =>
        DuckDbSql.Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.{PluginDerivationTable} (
                plugin       VARCHAR {FilenameIdentity} NOT NULL,
                origin       VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                derived_from VARCHAR NOT NULL,
                PRIMARY KEY (plugin, origin)
            )
            """);

    internal static void CreatePluginDiagnosisTable(DuckDBConnection connection) =>
        DuckDbSql.Execute(connection, $"""
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

    internal static void CreateFormReferencesTable(DuckDBConnection connection) =>
        DuckDbSql.Execute(connection, $"""
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

    // GRUP nesting lives here, not in the record document. One row per record a record holds in
    // the same plugin: a topic in its quest, a placed reference in its cell, a cell in its worldspace.
    internal static void CreateHoldingsTable(DuckDBConnection connection) =>
        DuckDbSql.Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.holdings (
                plugin      VARCHAR {FilenameIdentity} NOT NULL,
                origin      VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                parent      VARCHAR {FilenameIdentity} NOT NULL,
                child       VARCHAR {FilenameIdentity} NOT NULL,
                slot        VARCHAR NOT NULL,
                slot_index  INTEGER NOT NULL
            )
            """);

    // A cell's grid and block coordinates. The worldspace holding it is its holdings row; a cell no
    // holding holds is interior.
    internal static void CreateCellLocationTable(DuckDBConnection connection)
    {
        DuckDbSql.Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.cell_location (
                cell_form_key    VARCHAR {FilenameIdentity} NOT NULL,
                plugin           VARCHAR {FilenameIdentity} NOT NULL,
                origin           VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                block_x          INTEGER,
                block_y          INTEGER,
                sub_x            INTEGER,
                sub_y            INTEGER,
                grid_x           INTEGER,
                grid_y           INTEGER
            )
            """);
    }

    // A whole record type Mutagen could not finish enumerating: there is no record row to carry the
    // status, because the records it would have carried are the ones that never arrived.
    internal static void CreateRecordTypeFailureTable(DuckDBConnection connection)
    {
        DuckDbSql.Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.record_type_failure (
                plugin          VARCHAR {FilenameIdentity} NOT NULL,
                origin          VARCHAR {FilenameIdentity} NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type     VARCHAR NOT NULL,
                parse_diagnosis VARCHAR NOT NULL
            )
            """);
    }
}
