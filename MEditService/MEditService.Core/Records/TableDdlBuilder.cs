using System.Globalization;
using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Plugins;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

public sealed class TableDdlBuilder(SchemaReflector reflector)
{
    private readonly SchemaReflector _reflector = reflector;

    // ADR-0001: the physical data tables live in the `mirror` schema; the public names in
    // `main` are views over them scoped by registration (CreateRegisteredViews). Every relation
    // the read side — C# or the SQL door — names by its bare name is therefore registered-only, and
    // every writer names `mirror.` explicitly: a write against a view fails loudly in DuckDB, which
    // is what makes "writes go to mirror, reads go through registration" a property the database
    // enforces rather than a convention a new SQL string could quietly miss.
    internal const string MirrorSchema = "mirror";

    // One registered relation: a mirror table carrying a plugin identity, plus which
    // load-order-derived columns its view rebuilds. `registrations` itself is the registration and
    // stays a plain table in `main`, so it does not appear below. Neither does `mirror.files`,
    // which carries a plugin identity but must answer for plugins the load order does not
    // currently register — it is the mirror of the disk, and scoping it by registration would
    // blind the open-time validation to exactly the rows it exists to check.
    private readonly record struct RegisteredRelation(
        string Table, string PluginColumn, string OriginColumn, bool DerivesLoadOrder, bool DerivesWinner);

    // The list CreateRegisteredViews scopes.
    //
    // ADR-0001: `load_order_idx` lives only on `registrations` — none of these mirror
    // tables store it. The three whose readers ask for it (records, records_committed,
    // form_lookup) carry it as a derived column in their registered view, joined
    // from `registrations` rather than read off the row. ADR-0044: it is
    // nullable there — a copy no plugins.txt line names has no slot — and so nullable in the views.
    //
    // ADR-0001: `is_winner` is the same story one step further out. It is never a fact about
    // a row's bytes — it is a fact about the whole registered stack a FormKey sits in — so no
    // mirror table stores it, and the two relations whose readers ask for it
    // (`records`, `form_lookup`) derive it in their view by joining `winners`.
    // `records_committed` is not among them: nothing reads a winner flag on it
    // (records_head answers Head).
    //
    // Both join at Effective. `records_head` is the one relation with a stack of its own, and it
    // joins at RecordRef.Head accordingly.
    //
    // #631 removed a fourth entry, the header's own wide table. The plugin header is now an ordinary
    // `records` row, so it inherits that relation's registered view, its winner join and its ref
    // dimension rather than needing three of its own.
    private static readonly RegisteredRelation[] RegisteredRelations =
    [
        new("records", "plugin", "origin", DerivesLoadOrder: true, DerivesWinner: true),
        new("records_committed", "plugin", "origin", DerivesLoadOrder: true, DerivesWinner: false),
        new("form_references", "source_plugin", "source_origin", DerivesLoadOrder: false, DerivesWinner: false),
        new("form_lookup", "plugin", "origin", DerivesLoadOrder: true, DerivesWinner: true),
        new("placement", "plugin", "origin", DerivesLoadOrder: false, DerivesWinner: false),
        new("cell_location", "plugin", "origin", DerivesLoadOrder: false, DerivesWinner: false),
        new("container_child", "plugin", "origin", DerivesLoadOrder: false, DerivesWinner: false),
    ];

    /// <summary>The winners relation (<see cref="CreateWinnersTable"/>), named once so the sweep in
    /// <c>DuckDbRecordIndex.UpdateWinners</c> and the views that read it cannot drift. Bare — no
    /// schema prefix — because it is load-order-derived state, not a file mirror: it lives outside
    /// the mirror schema, in `main`, alongside <see cref="RegistrationsRelation"/>.</summary>
    internal const string WinnersRelation = "winners";

    /// <summary>The registration table (<see cref="CreateRegistrationsTable"/>): one row per physical
    /// plugin copy the load order holds, carrying ADR-0044's three facts (<c>load_order_idx</c>,
    /// <c>enabled</c>, <c>winning</c>). Registration is visibility (ADR-0001): every registered view
    /// joins it, so a row answers iff this table names its (plugin, origin). Participation is never
    /// a column here — see <see cref="ParticipatesPredicate"/>.</summary>
    internal const string RegistrationsRelation = "registrations";

    /// <summary>ADR-0044: participation, derived — the one SQL spelling of
    /// <see cref="Registration.Participates"/>, for the winner sweep to join on. <paramref name="alias"/>
    /// names the <see cref="RegistrationsRelation"/> row.</summary>
    internal static string ParticipatesPredicate(string alias) =>
        $"{alias}.enabled AND {alias}.winning AND {alias}.load_order_idx IS NOT NULL";

    /// <summary>
    /// <c>is_winner</c> for one relation's rows, at one ref, as a LEFT JOIN against the winners
    /// table — <see cref="WinnersRelation"/> holds at most one row per (ref, form_key) by
    /// construction (<c>DuckDbRecordIndex.UpdateWinners</c>), so joining it can never duplicate a row
    /// of <paramref name="alias"/>, and a hash join over the whole table beats a correlated EXISTS on
    /// the full-scan reads (Search, GetDocuments) that dominate this column's use.
    /// </summary>
    private static string WinnerJoin(string alias, RecordRef @ref, string pluginColumn, string originColumn) => $"""
        LEFT JOIN {WinnersRelation} w
               ON w.record_ref = '{WinnerRef.Of(@ref)}'
              AND w.form_key = {alias}.form_key
              AND w.plugin = {alias}.{pluginColumn}
              AND w.origin = {alias}.{originColumn}
        """;

    public void CreateTables(DuckDBConnection connection, GameRelease release)
    {
        Execute(connection, $"CREATE SCHEMA IF NOT EXISTS {MirrorSchema}");
        CreateRecordsTable(connection);
        CreateRegistrationsTable(connection);
        CreateWinnersTable(connection);
        CreateCommittedRecordsTable(connection);
        CreateFilesTable(connection);
        CreateFormReferencesTable(connection);
        CreateFormLookupTable(connection);
        CreatePlacementTables(connection);
        CreateContainerChildTable(connection);

        // ADR-0041: the reflector emits no per-type DDL at all. Every record type is a json_extract
        // VIEW over `records`, bearing the type's name — which is what keeps user filter SQL working
        // unchanged. Since #631 that includes the plugin header, which used to be the one exception
        // (a wide table, because it had no document to project a view over) and now has a document
        // like everything else.
        var schemas = _reflector.GetSchemas(release);

        // Views last, in dependency order: the registered views over every mirror table, then the
        // Head views over the registered `records`/`records_committed`, then the per-type views over
        // the registered `records` — so registration scopes all three layers through one predicate.
        CreateRegisteredViews(connection);
        CreateHeadView(connection);
        RecordViewBuilder.CreateViews(connection, schemas);
    }

    /// <summary>
    /// The one "registered" predicate (ADR-0001): a row answers iff a <c>registrations</c>
    /// row names its (plugin, origin). Each public relation is exactly its mirror table joined to
    /// that row, so the C# reads (which name the bare table) and the SQL door (user filter SQL,
    /// <c>medit.query</c>, the generated per-type views over <c>records</c>) cannot scope
    /// differently — there is no second place the scoping is written. The join doubles as
    /// <c>load_order_idx</c>'s one source of truth (ADR-0001): for the relations that carry
    /// it, the view adds <c>p.load_order_idx</c> rather than reading a stored column, because
    /// <c>registrations</c> is the only place that value lives — an INNER JOIN already excludes an
    /// unregistered plugin's rows, so filtering and load order
    /// come from the identical join rather than two separate mechanisms. Registered, not
    /// participating: ADR-0044 keeps a non-participating copy (a losing copy, a disabled line)
    /// visible on request beside the participating rows; only the winner sweep and the conflict
    /// classifier read the derived participation predicate.
    ///
    /// <para>ADR-0001: <c>is_winner</c> joins in the same way, from <c>winners</c>. Both
    /// derived columns are appended after <c>t.*</c>, so a mirror table's own columns keep their
    /// ordinal positions and only the load-order-derived ones move.</para>
    /// </summary>
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

    // ADR-0041: the documents table — one row per major record, holding that record's codec
    // JSON as its body beside the identity columns the read model is rebuilt on. The
    // extracted index tables below are populated from these
    // documents at ingest, and the reflector emits json_extract views over this table instead of
    // per-type DDL.
    //
    // `body` is VARCHAR, never DuckDB's JSON type: the JSON type normalizes what it stores, and
    // "the same bytes as the source file" is the entire load-bearing claim here — it is what makes
    // `content_hash` a real git object name (GitBlobHash) rather than a hash of some re-rendered
    // equivalent, and what lets a byte compare stand in for dirty/ITM detection later.
    //
    // `ref` (ADR-0041's ref dimension) — see SourceRef for the reserved values. Quoted everywhere
    // it appears: REF is a DuckDB keyword.
    //
    // Identity stays (form_key, origin, plugin) per ADR-0036 — no primary key declared, matching
    // every other table here, because indexing writes through appenders and re-index is
    // delete-then-append rather than upsert.
    //
    // ADR-0001: no `load_order_idx` column and no `is_winner` column
    // either. A record row carries file-derived facts only — load order is a fact about the plugin's
    // registration and winning is a fact about the registered stack the FormKey sits in, neither
    // about this row — and the registered "records" view (CreateRegisteredViews) joins both back in,
    // from `registrations` and `winners`, for every reader that names the view rather than
    // this mirror table.
    private static void CreateRecordsTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.records (
                form_key       VARCHAR NOT NULL,
                plugin         VARCHAR NOT NULL,
                origin         VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type    VARCHAR NOT NULL,
                editor_id      VARCHAR,
                "ref"          VARCHAR NOT NULL DEFAULT '{SourceRef.Committed}',
                body           VARCHAR NOT NULL,
                content_hash   VARCHAR NOT NULL
            )
            """);

        // form_key drives every single-record read (detail, override stack, compare) and the winner
        // sweep's correlated subquery; (plugin, origin) drives the per-plugin delete every re-index
        // starts with, and the per-plugin listings/counts.
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_records_form_key ON {MirrorSchema}.records(form_key)
            """);
        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_records_plugin ON {MirrorSchema}.records(plugin, origin)
            """);
    }

    // The committed half of the ref dimension. `records` holds exactly one row per record copy
    // and that row *is* Effective — so every read, and every generated
    // json_extract view, answers Effective with no ref predicate anywhere. What a
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
    // and removed by it again on convergence back to the committed bytes. Two
    // more writers sit on the ingest-from-source path: SeedCommittedOnly inserts a row with *no*
    // `records` counterpart (a record HEAD holds and the working tree deleted — present in this
    // table's half of records_head, absent from the other), and MarkWorkingTreeOnly deletes one (a
    // record the working tree holds and no commit does).
    private static void CreateCommittedRecordsTable(DuckDBConnection connection)
    {
        Execute(connection, $"""
            CREATE TABLE IF NOT EXISTS {MirrorSchema}.records_committed (
                form_key       VARCHAR NOT NULL,
                plugin         VARCHAR NOT NULL,
                origin         VARCHAR NOT NULL DEFAULT '{PluginOrigin.DataDirectory}',
                record_type    VARCHAR NOT NULL,
                editor_id      VARCHAR,
                "ref"          VARCHAR NOT NULL DEFAULT '{SourceRef.Committed}',
                body           VARCHAR NOT NULL,
                content_hash   VARCHAR NOT NULL
            )
            """);

        Execute(connection, $"""
            CREATE INDEX IF NOT EXISTS idx_records_committed_form_key ON {MirrorSchema}.records_committed(form_key)
            """);
    }

    /// <summary>
    /// The name of the Head <i>membership</i> relation — which (form_key, plugin, origin) rows exist
    /// at <see cref="RecordRef.Head"/>, with no winner column of its own. It lives in the mirror
    /// schema rather than beside <c>records_head</c> in <c>main</c> because it is not part of the
    /// published SQL door: it exists so that the winner sweep and <c>records_head</c> read one
    /// definition of "what Head holds" instead of two copies of the same UNION.
    /// </summary>
    internal const string HeadRowsRelation = $"{MirrorSchema}.head_rows";

    // Reads the registered `records`/`records_committed` views, not the mirror tables, so Head
    // is scoped by registration through the same predicate as Effective.
    private static void CreateHeadView(DuckDBConnection connection)
    {
        // The Head relation: every diverged record's committed snapshot, plus every record that
        // never diverged (still carrying SourceRef.Committed in `records` itself). The two halves
        // are disjoint by construction — ApplyWorkingTreeChanges writes the snapshot and flips the
        // Effective row's `ref` in the same transaction — so UNION ALL is exact, not an
        // approximation that DISTINCT would have to clean up after.
        // Both halves name `main.` explicitly: this view lives in `mirror`, so an unqualified
        // `records` would resolve to the mirror table sitting right beside it — the one relation
        // that is *not* scoped by registration and no longer carries load_order_idx at all.
        Execute(connection, $"""
            CREATE OR REPLACE VIEW {HeadRowsRelation} AS
            SELECT form_key, plugin, origin, record_type, editor_id, load_order_idx, "ref", body, content_hash
            FROM main.records_committed
            UNION ALL
            SELECT form_key, plugin, origin, record_type, editor_id, load_order_idx, "ref", body, content_hash
            FROM main.records WHERE "ref" = '{SourceRef.Committed}'
            """);

        // is_winner is Head's *own* answer, never the Effective one carried through, and that is
        // load-bearing rather than tidiness. A record the working tree deleted stops existing at
        // Effective, which promotes the next plugin down — and the promoted row is a clean row,
        // physically shared with this view. Reusing Effective's winner would leak that promotion into
        // the committed answer and report two winners for one FormKey at Head. So the sweep computes
        // a winner per ref (ADR-0001: `winners` is keyed by `record_ref` first), which
        // is what "IsWinner correct at the requested ref" means — and both refs' winners come out of
        // the one sweep in DuckDbRecordIndex.UpdateWinners, so they cannot disagree about what winning
        // is.
        Execute(connection, $"""
            CREATE OR REPLACE VIEW records_head AS
            SELECT h.form_key, h.plugin, h.origin, h.record_type, h.editor_id, h.load_order_idx,
                   (w.form_key IS NOT NULL) AS is_winner,
                   h."ref", h.body, h.content_hash
            FROM {HeadRowsRelation} h
            {WinnerJoin("h", RecordRef.Head, "plugin", "origin")}
            """);
    }

    /// <summary>
    /// ADR-0001: the winners relation — <c>(record_ref, form_key) -> (plugin, origin)</c>,
    /// one row naming the plugin whose copy of that FormKey wins at that ref. Winning is a function
    /// of the registered load order and nothing else, so it is load-order-owned state derived over
    /// the mirror rows, never a column on one of them: re-registering a plugin (a reorder, an enable,
    /// a disable, a change of winning copy) changes who wins without touching a single record row.
    /// It lives outside the mirror schema entirely — it is load-order-derived, not a
    /// file mirror — in `main`, alongside `registrations`.
    ///
    /// <para>Rebuilt wholesale by <c>DuckDbRecordIndex.UpdateWinners</c>
    /// and read only through the registered views
    /// and <c>records_head</c>, which join it to project <c>is_winner</c>. Materialized rather than
    /// left as a view because <c>is_winner</c> is a whole-table filter on the hot reads (Search,
    /// GetDocuments), which is exactly the cost the sweep exists to amortize.</para>
    ///
    /// <para>At most one row per (record_ref, form_key), which is what lets the readers LEFT JOIN it
    /// without risking a duplicated row. A tie on <c>load_order_idx</c> — two participating plugins
    /// registered at the same index, which LoadOrder.AddCreatedPlugin's slot allocation exists to
    /// prevent — therefore resolves to exactly one winner here. That
    /// uniqueness is by construction (the sweep's <c>QUALIFY ROW_NUMBER() = 1</c>) and deliberately
    /// not a declared PRIMARY KEY: the sweep rebuilds this table wholesale on every structural
    /// working-tree change, and maintaining DuckDB's ART index across that rebuild measured 6x the
    /// whole sweep's cost on a 48,000-record fixture (449ms against 75ms) for an invariant one
    /// statement already guarantees. No key is declared on any other table here either, for the
    /// related reason that indexing writes through appenders.</para>
    /// </summary>
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

    // ADR-0044: one row per physical plugin copy the load order holds — the registration table.
    // `load_order_idx` is the name's plugins.txt slot (null when no line names it), `enabled` is the
    // line's `*` prefix, `winning` is whether the Mod override order resolves the name to this copy.
    // Participation is never stored: it is `enabled AND winning AND load_order_idx IS NOT NULL`
    // (ParticipatesPredicate), which the winner sweep joins on so a losing or disabled copy's rows
    // can never win. Populated by DuckDbRecordIndex.Index/Register (upsert), not hand-maintained.
    // ADR-0036: `origin` (the mod folder that provided this physical file, or a reserved
    // PluginOrigin value) is part of this table's identity alongside `plugin` — two copies sharing a
    // filename but differing in origin are distinct rows, not a collision, and ADR-0044 makes both
    // of them ordinary: the losing copy is registered exactly like the winning one.
    //
    // ADR-0001: this table is *the load order*, and nothing else. It holds no fact about the
    // file a plugin's rows came from — that is `mirror.files` below, which outlives every registration
    // the file has ever held. It is not cleared when the index file is opened (ADR-0001 point 4,
    // amended by ADR-0044): its rows are the last known load order, and the first reconcile corrects
    // them.
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

    /// <summary>
    /// ADR-0001: what the index believes is on disk — one row per plugin whose rows the file
    /// holds, naming the physical file they were built from, that file's content hash, and the
    /// <see cref="IndexVersion"/> they were written under. This is the file-mirror half of the
    /// decision, and it is a separate table from <c>registrations</c> on purpose:
    /// <c>registrations</c> is the load order, so its rows come and go with every reconcile, while
    /// these rows change only when a <i>file</i> does. Storing the hash on the registration row
    /// instead would throw it away at the first unregister — which is exactly a profile switch, the
    /// case ADR-0001 exists to make cheap.
    ///
    /// <para>Written and deleted only by <c>DuckDbRecordIndex.Index</c>/<c>Unindex</c>, in the same
    /// transaction as the record rows they describe, so "the index holds current rows for this
    /// plugin" is one row's existence rather than a claim assembled from several tables.</para>
    /// </summary>
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

    // ADR-0031: global form_key -> (record type, EditorID) lookup, one row per (form_key, plugin),
    // extracted from the documents in the same ingest pass that writes each record's `records`
    // row, so CheckErrorBuilder and the compare resolvers resolve a FormKey in O(1).
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

    // ADR-0023: side tables for the worldspace tree. Parentage is structural (GRUP nesting),
    // so it lives here rather than on the reflected record tables — keeping placement read-only
    // by construction and isolating "move a ref between cells" as a structural op.
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

    // The ContainerChildFields relationships placement/cell_location don't already
    // carry (see ContainerChildRow for the set) — additive to the tables above, never a replacement
    // for what they already cover.
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

    private static void Execute(DuckDBConnection connection, string sql)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
