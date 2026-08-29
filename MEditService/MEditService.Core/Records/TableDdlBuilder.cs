using System.Globalization;
using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

public sealed class TableDdlBuilder(ISchemaReflector reflector) : ITableDdlBuilder
{
    private readonly ISchemaReflector _reflector = reflector;

    // #582 / ADR-0001: the physical data tables live in the `raw` schema; the public names in
    // `main` are views over them scoped by registration (CreateRegisteredViews). Every relation
    // the read side — C# or the SQL door — names by its bare name is therefore registered-only, and
    // every writer names `raw.` explicitly: a write against a view fails loudly in DuckDB, which is
    // what makes "writes go to raw, reads go through registration" a property the database
    // enforces rather than a convention a new SQL string could quietly miss.
    internal const string RawSchema = "raw";

    // (table, plugin column, origin column, derives load_order_idx) for every relation that carries
    // a plugin identity — the list CreateRegisteredViews scopes. `plugins` itself is the registration
    // and stays a plain table in `main`; `index_state` carries no plugin identity.
    //
    // #583 / ADR-0001: `load_order_idx` lives only on `plugins` now — none of these raw tables store
    // it. The four that used to carry it as a stored column (records, records_committed, form_lookup,
    // the header table) get it back as a derived column in their registered view, joined from
    // `plugins` rather than read off the row; the rest never had one.
    private static readonly (string Table, string PluginColumn, string OriginColumn, bool DerivesLoadOrder)[] RegisteredRelations =
    [
        ("records", "plugin", "origin", true),
        ("records_committed", "plugin", "origin", true),
        ("form_references", "source_plugin", "source_origin", false),
        ("form_lookup", "plugin", "origin", true),
        ("placement", "plugin", "origin", false),
        ("cell_location", "plugin", "origin", false),
        ("container_child", "plugin", "origin", false),
        (HeaderIndexer.TableName, "plugin", "origin", true),
    ];

    public void CreateTables(DuckDBConnection connection, GameRelease release)
    {
        Execute(connection, $"CREATE SCHEMA IF NOT EXISTS {RawSchema}");
        CreateRecordsTable(connection);
        CreatePluginsTable(connection);
        CreateCommittedRecordsTable(connection);
        CreateIndexStateTable(connection);
        CreateFormReferencesTable(connection);
        CreateFormLookupTable(connection);
        CreatePlacementTables(connection);
        CreateContainerChildTable(connection);

        // ADR-0041 / #413: the reflector no longer emits per-type DDL. Every record type is a
        // json_extract VIEW over `records`, taking the name its wide table used to have — which is
        // what keeps user filter SQL reading the same through the swap. The header is the one
        // exception and the only surviving per-type table: a ModHeader is not a major record, so it
        // has no document to project a view over (D8).
        var schemas = _reflector.GetSchemas(release);
        if (schemas.TryGetValue(HeaderIndexer.TableName, out var headerSchema))
            CreateRecordTable(connection, headerSchema);

        // Views last, in dependency order: the registered views over every raw table, then the
        // Head view over the registered `records`/`records_committed`, then the per-type views over
        // the registered `records` — so registration scopes all three layers through one predicate.
        CreateRegisteredViews(connection);
        CreateHeadView(connection);
        RecordViewBuilder.CreateViews(connection, schemas);
    }

    /// <summary>
    /// The one "registered" predicate (#582 / ADR-0001): a row answers iff a <c>plugins</c> row
    /// names its (plugin, origin). Each public relation is exactly its raw table joined to that row,
    /// so the C# reads (which name the bare table) and the SQL door (user filter SQL,
    /// <c>medit.query</c>, the generated per-type views over <c>records</c>) cannot scope
    /// differently — there is no second place the scoping is written. The join doubles as
    /// <c>load_order_idx</c>'s one source of truth (#583 / ADR-0001): for the relations that carry
    /// it, the view adds <c>p.load_order_idx</c> rather than reading a stored column, because
    /// <c>plugins</c> is the only place that value lives — an INNER JOIN already excludes an
    /// unregistered plugin's rows, same as the EXISTS this replaces, so filtering and load order
    /// come from the identical join rather than two separate mechanisms.
    /// </summary>
    private static void CreateRegisteredViews(DuckDBConnection connection)
    {
        foreach (var (table, pluginColumn, originColumn, derivesLoadOrder) in RegisteredRelations)
        {
            var loadOrderColumn = derivesLoadOrder ? ", p.load_order_idx" : "";
            Execute(connection, $"""
                CREATE OR REPLACE VIEW "{table}" AS
                SELECT t.*{loadOrderColumn}
                FROM {RawSchema}."{table}" t
                JOIN plugins p ON p.plugin = t.{pluginColumn} AND p.origin = t.{originColumn}
                """);
        }
    }

    // ADR-0041 / #413: the documents table — one row per major record, holding that record's codec
    // JSON as its body beside the identity columns the read model is rebuilt on. Replaces the
    // reflected per-type wide tables; the extracted index tables below are populated from these
    // documents at ingest, and the reflector emits json_extract views over this table instead of
    // per-type DDL.
    //
    // `body` is VARCHAR, never DuckDB's JSON type: the JSON type normalizes what it stores, and
    // "the same bytes as the source file" is the entire load-bearing claim here — it is what makes
    // `content_hash` a real git object name (GitBlobHash) rather than a hash of some re-rendered
    // equivalent, and what lets a byte compare stand in for dirty/ITM detection later.
    //
    // `ref` (ADR-0041's ref dimension) carries
    // exactly one value in this ticket — see SourceRef, which explains why it is here now rather
    // than added once #415 gives it a second. Quoted everywhere it appears: REF is a DuckDB keyword.
    //
    // Identity stays (form_key, origin, plugin) per ADR-0036 — no primary key declared, matching
    // every other table here, because indexing writes through appenders and re-index is
    // delete-then-append rather than upsert.
    //
    // #583 / ADR-0001: no `load_order_idx` column. A record row carries file-derived facts only —
    // load order is a fact about the plugin's registration, not about this row, and the registered
    // "records" view (CreateRegisteredViews) joins it in from `plugins` for every reader that names
    // the view rather than this raw table.
    private static void CreateRecordsTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {RawSchema}.records (
                form_key       VARCHAR NOT NULL,
                plugin         VARCHAR NOT NULL,
                origin         VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type    VARCHAR NOT NULL,
                editor_id      VARCHAR,
                is_winner      BOOLEAN NOT NULL DEFAULT FALSE,
                "ref"          VARCHAR NOT NULL DEFAULT '{SourceRef.Committed}',
                body           VARCHAR NOT NULL,
                content_hash   VARCHAR NOT NULL
            )
            """);

        // form_key drives every single-record read (detail, override stack, compare) and the winner
        // sweep's correlated subquery; (plugin, origin) drives the per-plugin delete every re-index
        // starts with, and the per-plugin listings/counts.
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_records_form_key ON {RawSchema}.records(form_key)
            """);
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_records_plugin ON {RawSchema}.records(plugin, origin)
            """);
    }

    // #415: the committed half of the ref dimension. `records` holds exactly one row per record copy
    // and that row *is* Effective — so every read written before this ticket, and every generated
    // json_extract view, keeps answering Effective unchanged, with no ref predicate anywhere. What a
    // second ref needs is only the *difference*, which is what this table holds: the committed
    // snapshot of a record whose working-tree state has diverged, and nothing at all for the clean
    // majority.
    //
    // Deliberately a mirror of `records` column-for-column rather than a narrower (form_key, body)
    // pair: `records_head` below is a plain UNION ALL of this table with the still-clean rows, so
    // Head is a relation of exactly the same shape as `records` and every read can be pointed at
    // either by name alone. A narrower table would force each Head read to reconstruct the missing
    // identity columns by joining back to the Effective row — which does not exist at all for a
    // record the working tree deleted, the very case Head has to keep answering.
    //
    // Rows are written by DuckDbRecordIndex.ApplyWorkingTreeChanges (on the clean→dirty transition)
    // and removed by it again on convergence back to the committed bytes. Since #452 there are two
    // more writers, both on the ingest-from-source path: SeedCommittedOnly inserts a row with *no*
    // `records` counterpart (a record HEAD holds and the working tree deleted — present in this
    // table's half of records_head, absent from the other), and MarkWorkingTreeOnly deletes one (a
    // record the working tree holds and no commit does).
    private static void CreateCommittedRecordsTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {RawSchema}.records_committed (
                form_key       VARCHAR NOT NULL,
                plugin         VARCHAR NOT NULL,
                origin         VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type    VARCHAR NOT NULL,
                editor_id      VARCHAR,
                is_winner      BOOLEAN NOT NULL DEFAULT FALSE,
                "ref"          VARCHAR NOT NULL DEFAULT '{SourceRef.Committed}',
                body           VARCHAR NOT NULL,
                content_hash   VARCHAR NOT NULL
            )
            """);

        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_records_committed_form_key ON {RawSchema}.records_committed(form_key)
            """);
    }

    // #582: reads the registered `records`/`records_committed` views, not the raw tables, so Head is
    // scoped by registration through the same predicate as Effective.
    private static void CreateHeadView(DuckDBConnection connection)
    {
        // The Head relation: every diverged record's committed snapshot, plus every record that
        // never diverged (still carrying SourceRef.Committed in `records` itself). The two halves
        // are disjoint by construction — ApplyWorkingTreeChanges writes the snapshot and flips the
        // Effective row's `ref` in the same transaction — so UNION ALL is exact, not an
        // approximation that DISTINCT would have to clean up after.
        //
        // is_winner is *derived here*, not carried through from either half, and that is load-bearing
        // rather than tidiness. A record the working tree deleted stops existing at Effective, which
        // promotes the next plugin down — and the promoted row is a clean row, physically shared with
        // this view. Reading its stored flag would leak an Effective-only promotion into the committed
        // answer and report two winners for one FormKey at Head. Deriving instead makes each ref's
        // winner a fact about the stack *at that ref*, which is what "IsWinner correct at the
        // requested ref" means; the correlated shape mirrors DuckDbRecordIndex.UpdateWinners' own
        // sweep, participation join included, so the two cannot disagree about what winning is.
        Execute(connection, $"""
            CREATE OR REPLACE VIEW records_head AS
            WITH head AS (
                SELECT form_key, plugin, origin, record_type, editor_id, load_order_idx, "ref", body, content_hash
                FROM records_committed
                UNION ALL
                SELECT form_key, plugin, origin, record_type, editor_id, load_order_idx, "ref", body, content_hash
                FROM records WHERE "ref" = '{SourceRef.Committed}'
            )
            SELECT h.form_key, h.plugin, h.origin, h.record_type, h.editor_id, h.load_order_idx,
                   (
                     EXISTS (
                       SELECT 1 FROM plugins p1
                       WHERE p1.plugin = h.plugin AND p1.origin = h.origin AND p1.participates)
                     AND h.load_order_idx = (
                       SELECT MAX(h2.load_order_idx) FROM head h2
                       JOIN plugins p2 ON p2.plugin = h2.plugin AND p2.origin = h2.origin AND p2.participates
                       WHERE h2.form_key = h.form_key)
                   ) AS is_winner,
                   h."ref", h.body, h.content_hash
            FROM head h
            """);
    }

    // #267 / ADR-0035: `participates` is the plugins.txt `*` prefix — the one row per plugin that
    // UpdateWinners()'s per-table sweep joins against so a disabled plugin's row can never win.
    // Populated by DuckDbRecordIndex.Index (one row per indexed plugin), not hand-maintained.
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
            CREATE TABLE IF NOT EXISTS {RawSchema}.form_references (
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
                ON {RawSchema}.form_references(target_form_key)
            """);
    }

    // ADR-0031: global form_key -> (record type, EditorID) lookup, one row per (form_key, plugin),
    // extracted from the documents in the same ingest pass that writes each record's `records`
    // row, so CheckErrorBuilder and the compare resolvers resolve a FormKey in O(1).
    internal static void CreateFormLookupTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {RawSchema}.form_lookup (
                form_key       VARCHAR NOT NULL,
                plugin         VARCHAR NOT NULL,
                origin         VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type    VARCHAR NOT NULL,
                editor_id      VARCHAR,
                is_winner      BOOLEAN NOT NULL DEFAULT FALSE
            )
            """);
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_form_lookup_form_key
                ON {RawSchema}.form_lookup(form_key)
            """);
    }

    // ADR-0023: side tables for the worldspace tree. Parentage is structural (GRUP nesting),
    // so it lives here rather than on the reflected record tables — keeping placement read-only
    // by construction and isolating "move a ref between cells" as a structural op.
    internal static void CreatePlacementTables(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {RawSchema}.placement (
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
                ON {RawSchema}.placement(parent_cell, plugin)
            """);

        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {RawSchema}.cell_location (
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
                ON {RawSchema}.cell_location(parent_worldspace, plugin)
            """);
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_cell_location_region
                ON {RawSchema}.cell_location(parent_worldspace, grid_x, grid_y)
            """);
    }

    // #416 S1b: the five ContainerChildFields relationships placement/cell_location don't already
    // carry (Cell.NavigationMeshes/Landscape, Quest.DialogBranches/DialogTopics,
    // DialogTopic.Responses) — additive to the tables above, never a replacement for what they
    // already cover.
    internal static void CreateContainerChildTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {RawSchema}.container_child (
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
                ON {RawSchema}.container_child(parent_form_key, plugin)
            """);
    }

    // #271 / ADR-0036: `origin` is part of every record table's identity alongside `plugin` — the
    // composite key is (form_key, origin, plugin). Placed right after `plugin` (not load-bearing for
    // the explicit-column-list reads in DuckDbRecordIndex, which never SELECT *).
    private static void CreateRecordTable(DuckDBConnection connection, RecordTableSchema schema)
    {
        var sb = new StringBuilder();
        sb.Append("form_key VARCHAR NOT NULL, ");
        sb.Append("plugin VARCHAR NOT NULL, ");
        sb.Append(CultureInfo.InvariantCulture, $"origin VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}', ");
        sb.Append("is_winner BOOLEAN NOT NULL DEFAULT FALSE, ");
        sb.Append("editor_id VARCHAR");

        foreach (var col in schema.RecordColumns)
            sb.Append(CultureInfo.InvariantCulture, $", \"{col.Name}\" {col.DuckDbType}");

        Execute(connection, $"CREATE TABLE IF NOT EXISTS {RawSchema}.\"{schema.TableName}\" ({sb})");
    }

    private static void Execute(DuckDBConnection connection, string sql)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
