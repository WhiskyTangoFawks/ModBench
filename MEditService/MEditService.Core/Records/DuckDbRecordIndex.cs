using System.Data;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

// The record index — the single DuckDB implementation of IRecordIndex/IRecordReads.
//
// Internally split into three collaborators, each private to this module — IndexStore
// (connection/DDL/validate/rebuild), PluginIngest (prepare/append/collectors) and WorkingTreeOverlay
// (ApplyWorkingTreeChanges/SetCommittedBaseline/Seed+Mark/rederivation). This class remains the one
// public IRecordIndex/IRecordReads implementation and their orchestrator: it owns every transaction
// boundary and the registration/winner-sweep/reads/container-verb/SQL-door responsibilities, calling
// into the three collaborators for the rest.
public sealed class DuckDbRecordIndex : IRecordIndex
{
    private readonly SchemaReflector _schemaReflector;
    private readonly ILogger _logger;
    private IReadOnlyDictionary<string, RecordTableSchema>? _schemas;
    private readonly PlacementWalker _placementWalker = new();
    private static readonly string[] PlacedTableNames = ["refr", "achr"];
    private bool _filterActive;

    // ADR-0041: the per-record source codec, the ingest path for every record —
    // each document body is exactly the bytes the record's source file holds. Constructed here
    // rather than injected: it is stateless apart from its own reflection caches (which are static),
    // and every existing construction site of this repository would otherwise have to learn about a
    // dependency it has no say in. Shared with PluginIngest (constructed below), which is the only
    // other place a document is serialized or deserialized.
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);

    // The connection/DDL/validate/rebuild collaborator — see IndexStore's own doc
    // comment. Connection forwards to it rather than being held here, so a rebuild that reassigns
    // IndexStore's own Connection field is transparent to every existing `.Connection` reader
    // (production and the white-box test surface alike) with no change on their side.
    private readonly IndexStore _indexStore;

    // The prepare/append/collectors collaborator — see PluginIngest's own doc comment.
    // Constructed at the end of Initialize (below), once Connection is stable for the rest of this
    // object's lifetime (IndexStore never rebuilds again after Initialize returns) and schemas /
    // the condition codec / the release are all resolved — every one of PluginIngest's dependencies
    // is captured once rather than chased through a mutable back-reference.
    private PluginIngest _pluginIngest = null!;

    // The working-tree overlay collaborator — see WorkingTreeOverlay's own doc comment.
    // Constructed alongside _pluginIngest, at the end of Initialize, for the identical reason (every
    // dependency captured once rather than chased through a mutable back-reference) — and after it,
    // since it depends on PluginIngest one-directionally.
    private WorkingTreeOverlay _workingTreeOverlay = null!;

    public DuckDBConnection Connection => _indexStore.Connection;

    public DuckDbRecordIndex(
        SchemaReflector schemaReflector,
        TableDdlBuilder ddlBuilder,
        ILogger logger,
        string? databasePath = null)
    {
        _schemaReflector = schemaReflector;
        _logger = logger;
        _indexStore = new IndexStore(ddlBuilder, logger, databasePath);
    }

    // Reading a record back out of its document needs the release it was written under, and this
    // repository is one game for its whole lifetime — the same reasoning that already resolves the
    // condition codec once, here.
    private GameRelease _release;

    public void Initialize(GameRelease release)
    {
        var indexVersion = IndexVersion.For(_schemaReflector, release);
        // Before the schemas, not after: IndexStore's own version check throws away a file written
        // under a different shape *before* this process starts appending to tables it only half
        // recognizes.
        _indexStore.Initialize(release, indexVersion);

        _schemas = _schemaReflector.GetSchemas(release);
        // Resolved once here (this repository is one game/load order for its whole lifetime),
        // handed to PluginIngest below rather than kept as a field of this class — CollectConditionRefsForRecord's
        // only other caller (WorkingTreeOverlay's own rederivation) reaches it through the same
        // PluginIngest instance. Null for a game with no condition codec — same "fails to nothing,
        // not silently wrong" fallback ConditionCodecRegistry.For already establishes elsewhere.
        var conditionCodec = ConditionCodecRegistry.For(release.ToCategory());
        _release = release;

        _pluginIngest = new PluginIngest(Connection, _logger, _codec, _placementWalker, conditionCodec);
        _workingTreeOverlay = new WorkingTreeOverlay(
            Connection, _logger, _codec, _placementWalker, _pluginIngest, release, _schemas);

        // IndexStore only ever computes and reports the stale set — it
        // is never the one to act on it. Unindex is this class's own cross-cutting verb (registration
        // + every ingest-owned table), so acting on the answer stays here.
        foreach (var key in _indexStore.ValidateAgainstDisk())
            Unindex(key);
    }

    // --- Indexing (absorbed from RecordIndexer) ---

    public void Index(IModGetter plugin, Registration registration, PluginKey key, string? filePath = null) =>
        Index(plugin, registration, key.Origin!, filePath);

    /// <summary>See <see cref="IRecordIndex.IndexedContentHash"/>.</summary>
    public string? IndexedContentHash(PluginKey key) => _indexStore.IndexedContentHash(key);

    // origin (ADR-0036): the mod folder that provided this physical file, or a reserved
    // PluginOrigin value. Required — threaded into every per-plugin delete/upsert/append
    // below so a plugin is identified by (origin, plugin) together, not filename alone: two
    // plugins sharing a filename but differing in origin never collide.
    private void Index(IModGetter pluginMod, Registration registration, string origin, string? filePath)
    {
        var schemas = RequireSchemas();
        var plugin = pluginMod.ModKey.FileName.ToString();

        // One transaction for the whole reindex so a throw partway leaves the prior committed
        // read model intact rather than a partial snapshot. DuckDB appenders enroll in the active
        // transaction, so deletes and appender flushes roll back together on Dispose-without-Commit.
        using var tx = Connection.BeginTransaction();

        // One `registrations` row per indexed plugin — UpdateWinners() joins against it so a
        // non-participating copy's rows never win regardless of load_order_idx.
        UpsertRegistration(plugin, origin, registration);
        // And the disk claim these rows are about, replaced with them rather than beside them.
        _indexStore.StampIndexedFile(plugin, origin, filePath);

        // Must run before the appender is created — see PluginIngest.DeletePriorDocuments's own
        // doc comment.
        _pluginIngest.DeletePriorDocuments(plugin, origin);

        // The appender's `using` scope stays here rather than moving into PluginIngest, so its
        // disposal keeps the required ordering relative to tx.Commit() below (tx declared first,
        // documentAppender second — both dispose, LIFO, after every statement in this method,
        // including the commit and the log).
        using var documentAppender = Connection.CreateAppender("mirror", "records");
        var timing = _pluginIngest.IndexPlugin(pluginMod, plugin, origin, schemas, documentAppender);

        var commitTimer = Stopwatch.StartNew();
        tx.Commit();
        // Per-phase load timing — "documents" spans record enumeration plus every per-record
        // cost (serialize, hash, form/VMAD/condition refs, container children, append); "extracted"
        // spans placement/header and the form_references/form_lookup/container_child flushes.
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug(
                "Index {Plugin}: documents {DocumentsMs} ms (prepare {PrepareMs} ms, append {AppendMs} ms), extracted tables {ExtractedMs} ms, commit {CommitMs} ms",
                plugin, timing.DocumentsMs, timing.PrepareMs, timing.AppendMs, timing.ExtractedMs, commitTimer.ElapsedMilliseconds);
        }
    }

    public void Unindex(PluginKey key) => Unindex(key.Name, key.Origin!);

    // The inverse of Index, table for table — same transaction discipline, and deliberately built
    // from the same per-plugin delete helpers Index itself calls before each append, so a new
    // indexed table cannot be added to one side without the other noticing (they are the same
    // calls). The `registrations` row is dropped last: it is the row UpdateWinners joins against, and while
    // it exists this (origin, plugin) is still a known member of the read model.
    private void Unindex(string plugin, string origin)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Unindexing {Plugin} from {Origin}", plugin, origin);
        }
        using var tx = Connection.BeginTransaction();

        // PluginIngest.DeleteAllRowsFor is the ingest-owned half — every table a
        // fresh Index() populates, table for table (deliberately built from the same per-plugin
        // delete helper Index itself calls, so a new indexed table cannot be added to one side
        // without the other noticing — they are the same calls).
        _pluginIngest.DeleteAllRowsFor(plugin, origin);
        // The file claim goes with the rows it describes — Unindex is the file-gone verb, so
        // leaving it behind would leave the mirror asserting rows the index no longer holds.
        _indexStore.DeleteIndexedFile(plugin, origin);
        DeleteRegistration(plugin, origin);

        tx.Commit();
    }

    // ADR-0035: one row per registered copy, upserted by every Index() and Register() call.
    // UpdateWinners() joins `records` against it rather than carrying a participates column per row
    // — and since ADR-0044 not even this row carries one: participation is derived from the three
    // facts stored here (TableDdlBuilder.ParticipatesPredicate).
    private void UpsertRegistration(string plugin, string origin, Registration registration)
    {
        DeleteRegistration(plugin, origin);
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"INSERT INTO {TableDdlBuilder.RegistrationsRelation} (plugin, origin, load_order_idx, enabled, winning) VALUES ($1, $2, $3, $4, $5)";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        cmd.Parameters.Add(new DuckDBParameter { Value = (object?)registration.LoadOrderIndex ?? DBNull.Value });
        cmd.Parameters.Add(new DuckDBParameter { Value = registration.Enabled });
        cmd.Parameters.Add(new DuckDBParameter { Value = registration.Winning });
        cmd.ExecuteNonQuery();
    }

    // ADR-0001: registration is visibility. The `registrations` row is the whole of a
    // copy's membership in the load order — every public relation (`records`, the extracted tables,
    // every generated per-type view) is a view over its `mirror.` table joined to this row (see
    // TableDdlBuilder.CreateRegisteredViews for the one predicate they all share), so writing or
    // deleting the row is what makes a plugin's rows answer or fall silent. Neither verb touches a
    // data row: Register after Unregister answers again with no re-index, and Unregister leaves
    // Index()'s work intact for the next load order that wants it. Unindex is the file-gone verb.
    public void Register(PluginKey key, Registration registration) =>
        UpsertRegistration(key.Name, key.Origin!, registration);

    public void Unregister(PluginKey key)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Unregistering {Plugin} from {Origin}", key.Name, key.Origin);
        }
        DeleteRegistration(key.Name, key.Origin!);
    }

    /// <summary>See <see cref="IRecordIndex.RegisteredPlugins"/>.</summary>
    public IReadOnlyList<PluginKey> RegisteredPlugins()
    {
        var keys = new List<PluginKey>();
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT plugin, origin FROM {TableDdlBuilder.RegistrationsRelation}";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            keys.Add(new PluginKey(reader.GetString(0), reader.GetString(1)));
        return keys;
    }

    private void DeleteRegistration(string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"DELETE FROM {TableDdlBuilder.RegistrationsRelation} WHERE plugin = $1 AND origin = $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        cmd.ExecuteNonQuery();
    }

    /// <summary>See <see cref="IRecordIndex.UpdateWinners"/>.</summary>
    ///
    /// <remarks>
    /// ADR-0001: winning is a function of the registered load order alone, so it lives in
    /// <c>winners</c> — one row per (ref, FormKey) naming the plugin whose copy wins — and is
    /// rebuilt wholesale here rather than UPDATEd onto a column of three separate data tables. The
    /// readers never name this table: the registered views and <c>records_head</c> join it to project
    /// <c>is_winner</c>, so the projection is written once (<c>TableDdlBuilder</c>) and the rule once
    /// (here), instead of once per relation in each place.
    ///
    /// <para>ADR-0036: partitioned on (plugin, origin) together — two plugins sharing a
    /// filename but differing in origin are distinct participants, each judged on its own
    /// load_order_idx and participation, not folded into one bucket by filename alone.
    /// ADR-0001: that load_order_idx is read from the <c>registrations</c> row the participation
    /// join already needs, never from the record row. ADR-0044: participation itself is derived
    /// there too (<see cref="TableDdlBuilder.ParticipatesPredicate"/>) — a losing copy and a
    /// disabled line are both registered and both excluded here by the same predicate.</para>
    ///
    /// <para>Wholesale rather than incremental because there is no smaller correct unit: registering
    /// a plugin at a new index can move the winner of every FormKey it holds. Measured over a
    /// 48,000-record, 60-plugin fixture — larger than the overwhelming majority of real load
    /// orders — at ~75ms for both refs, with the winner-filtered reads unchanged: the registered
    /// view's <c>registrations</c> join already dominates them, and joining <c>winners</c> beside
    /// it costs nothing measurable.</para>
    /// </remarks>
    public void UpdateWinners()
    {
        Execute($"DELETE FROM {TableDdlBuilder.WinnersRelation}");

        // Effective. One relation, no union: since #631 the plugin header is an ordinary `records`
        // row, so it is swept here by construction rather than by a second SELECT of its own — and
        // its FormKeys still cannot collide with a record's, since HeaderIndexer.FormKeyFor mints
        // them at FormID 000000, the null form, which no major record can occupy.
        //
        // form_lookup gets no branch here either: ADR-0031 keeps exactly one lookup row per Effective
        // record row (ingest appends them together — the header's included — and
        // RederiveIndexRowsForRecord/DeleteDerivationsForRecord keep them in step), so `records`' own
        // winners *are* form_lookup's, and its registered view joins the same rows. That is what makes
        // ResolveFormKey's EditorID reflect the winning override by construction rather than by a
        // second sweep that could drift from this one.
        InsertWinners(RecordRef.Effective, "SELECT form_key, plugin, origin FROM mirror.records");

        // Head, over the same membership relation records_head itself is built on. A record the
        // working tree deleted is gone from Effective but still held at Head, so the two stacks can
        // name different winners for one FormKey — see TableDdlBuilder.CreateHeadView.
        InsertWinners(RecordRef.Head, $"SELECT form_key, plugin, origin FROM {TableDdlBuilder.HeadRowsRelation}");
    }

    // The winner rule itself, once: among the rows <paramref name="rowsSql"/> yields, the one whose
    // plugin is registered, participating, and latest in the load order wins its FormKey. QUALIFY
    // (rather than the MAX() compare this replaces) is what makes the result a function — a tie on
    // load_order_idx yields one winner, not two — and the (plugin, origin) tiebreak makes which one
    // deterministic rather than dependent on scan order.
    private void InsertWinners(RecordRef @ref, string rowsSql) =>
        Execute($"""
            INSERT INTO {TableDdlBuilder.WinnersRelation} (record_ref, form_key, plugin, origin)
            SELECT '{WinnerRef.Of(@ref)}', r.form_key, r.plugin, r.origin
            FROM ({rowsSql}) r
            JOIN {TableDdlBuilder.RegistrationsRelation} p
              ON p.plugin = r.plugin AND p.origin = r.origin AND {TableDdlBuilder.ParticipatesPredicate("p")}
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY r.form_key
                ORDER BY p.load_order_idx DESC, r.plugin, r.origin) = 1
            """);

    // --- Working-tree changes ---

    /// <summary>See <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>. One transaction for the whole
    /// batch, matching <see cref="Index"/>'s own discipline: a throw partway leaves the prior read
    /// model intact rather than a half-applied edit whose Effective and Head disagree about which
    /// records diverged.</summary>
    public void ApplyWorkingTreeChanges(PluginKey key, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        if (deltas.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        // Only a delta that added or removed a row can move winner status: a field edit leaves the
        // stack exactly as it was. Re-swept for the whole load order rather than for the touched
        // FormKeys because UpdateWinners is the one definition of winning in this class, and a
        // second, scoped copy of that SQL is precisely how the two would come to disagree.
        //
        // Measured: a throwaway fixture of 48,000 records across 60 participating plugins —
        // larger than the overwhelming majority of real load orders — put one whole-load-order
        // UpdateWinners() call at 18ms. That is not a hot path by any interactive-latency bar, so
        // this stays whole-load-order rather than FormKey-scoped; re-measure if a real load order's shape
        // ever makes this number look different.
        if (_workingTreeOverlay.ApplyWorkingTreeChanges(key, deltas)) UpdateWinners();
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.CreateWorkingTreeRecord"/>.</summary>
    public void CreateWorkingTreeRecord(PluginKey key, string formKey, string recordType, string body)
    {
        if (_workingTreeOverlay.RowExistsAtEffective(key, formKey) || _workingTreeOverlay.RowExistsAtHead(key, formKey))
        {
            throw new ArgumentException(
                $"{key.Name} ({key.Origin}) already holds {formKey} at some ref — CreateWorkingTreeRecord " +
                "is only for a FormKey neither ref answers to.", nameof(formKey));
        }

        using var tx = Connection.BeginTransaction();
        _workingTreeOverlay.CreateWorkingTreeRecord(key, formKey, recordType, body);
        // A create is always structural — a row that did not exist at Effective now does — so this
        // always resweeps, the same trigger ApplyWorkingTreeChanges's own structural deltas use.
        UpdateWinners();
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.SetCommittedBaseline"/>.</summary>
    public void SetCommittedBaseline(PluginKey key, IReadOnlyList<(string FormKey, string Body)> baselines)
    {
        if (baselines.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        _workingTreeOverlay.SetCommittedBaseline(key, baselines);
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.MarkWorkingTreeOnly"/>.</summary>
    public void MarkWorkingTreeOnly(PluginKey key, IReadOnlyList<string> formKeys)
    {
        if (formKeys.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        _workingTreeOverlay.MarkWorkingTreeOnly(key, formKeys);
        // Effective is untouched — nothing was added to or removed from it — but Head just lost a row
        // per FormKey, which can promote the next plugin down at that ref. Head's winners are swept,
        // not derived per read (ADR-0001), so the sweep has to run: whole-load-order, because
        // UpdateWinners is the one definition of winning in this class and a scoped copy of that SQL
        // is precisely how the two would come to disagree.
        UpdateWinners();
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.SeedCommittedOnly"/>. One transaction for the whole batch,
    /// matching <see cref="SetCommittedBaseline"/> and <see cref="MarkWorkingTreeOnly"/> — the three
    /// head-state writes are all-or-nothing together, so a throw partway through a reconciliation pass
    /// cannot leave half of one applied.</summary>
    public void SeedCommittedOnly(PluginKey key, IReadOnlyList<(string FormKey, string RecordType, string Body)> records)
    {
        if (records.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        _workingTreeOverlay.SeedCommittedOnly(key, records);
        // The mirror of MarkWorkingTreeOnly's sweep: Head just gained a row per FormKey, which can
        // demote whoever was winning it at that ref. Effective is untouched either way.
        UpdateWinners();
        tx.Commit();
    }

    // --- Queries ---

    // The two relations the ref dimension resolves to. `records` holds one row per record copy
    // and that row *is* Effective, so every read below reaches its ref by naming a relation of the
    // same shape — no read carries a ref predicate, and none of them changed shape to gain a ref.
    // `records_head` is the UNION of the committed snapshots of diverged records with the rows that
    // never diverged (TableDdlBuilder.CreateCommittedRecordsTableAndHeadView).
    private const string EffectiveRelation = "records";
    private const string HeadRelation = "records_head";

    // Created on first ask and reused: each is a stateless projection over this same connection, and
    // At() is called per read on hot paths (GetCompare walks an override stack through it).
    private IRecordReads? _effectiveReads;
    private IRecordReads? _headReads;

    /// <summary>
    /// Head and Effective genuinely diverge — a record carrying a working-tree change
    /// serves the edited bytes at <see cref="RecordRef.Effective"/> and the committed ones at
    /// <see cref="RecordRef.Head"/>. For a record with no working-tree change the two relations hold
    /// the same row by construction, so the answers stay identical, which is what
    /// <c>RecordRefDivergenceTests</c> pins for the unedited case.
    ///
    /// <para>The reads that answer from the <i>extracted</i> index tables rather than from documents
    /// — <see cref="Resolve"/>, <see cref="GetReferencedBy"/>, <see cref="GetPlacement"/> — answer
    /// identically at both refs, deliberately: those tables carry no ref dimension, they track
    /// Effective (a FormKey should resolve to what the link points at *now*), and the committed
    /// question consumers actually ask is a document question, answered from
    /// <see cref="RecordOverrides"/>'s own Head bodies.</para>
    ///
    /// <para><see cref="RelationReads"/> is the one implementation for every member of
    /// <see cref="IRecordReads"/> — this instance's own public surface (below) is nothing but
    /// <c>At(RecordRef.Effective)</c>, so a read cannot behave differently reached the two ways.</para>
    /// </summary>
    public IRecordReads At(RecordRef recordRef)
    {
        if (recordRef == RecordRef.Head)
        {
            _headReads ??= new RelationReads(this, HeadRelation);
            return _headReads;
        }
        _effectiveReads ??= new RelationReads(this, EffectiveRelation);
        return _effectiveReads;
    }

    /// <summary>
    /// The one implementation of every <see cref="IRecordReads"/> member, parameterized by
    /// which relation its SQL names — both <see cref="At"/>(<see cref="RecordRef.Effective"/>) and
    /// <see cref="At"/>(<see cref="RecordRef.Head"/>) are an instance of this class and nothing else,
    /// so a read cannot be ref-aware on one path and not the other: exactly one body per read,
    /// reached through exactly one door.
    /// </summary>
    private sealed class RelationReads(DuckDbRecordIndex owner, string records) : IRecordReads
    {
        public RecordDocument? GetDocument(string formKey)
        {
            owner.RequireSchemas(); // fail before touching the DB when Initialize hasn't run, matching every other read here
            var tableName = owner.FindRecordType(records, formKey);
            return tableName == null ? null : owner.ReadDocument(records, tableName, formKey, plugin: null, origin: null, winnerOnly: true);
        }

        public RecordDocument? GetDocument(string formKey, PluginKey plugin)
        {
            owner.RequireSchemas();
            var tableName = owner.FindRecordType(records, formKey);
            return tableName == null ? null : owner.ReadDocument(records, tableName, formKey, plugin.Name, plugin.Origin, winnerOnly: false);
        }

        // One query rather than two point queries per record (FindRecordType + ReadDocument would
        // be ~7,880 round trips for one compile of a real 3,940-record fixture). Rows are
        // materialized before any reconstitution: resolving a referenced FormKey opens its own
        // command on this same connection, and doing that under a live reader would interleave two
        // readers (see GetOverrideStack).
        public IReadOnlyList<RecordDocument> GetDocuments(PluginKey plugin)
        {
            var schemas = owner.RequireSchemas();
            using var cmd = owner.Connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, record_type
                FROM {records}
                WHERE plugin = $1 AND origin = $2
                """;
            AddParams(cmd, [plugin.Name, plugin.Origin!]);
            using var reader = cmd.ExecuteReader();

            var rows = new List<(string FormKey, string Plugin, string Origin, int LoadOrderIndex,
                bool IsWinner, string? EditorId, string Body, string RecordType)>();
            while (reader.Read())
            {
                rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2),
                    LoadOrderSortKey(reader, 3), reader.GetBoolean(4),
                    reader.IsDBNull(5) ? null : reader.GetString(5),
                    reader.GetString(6), reader.GetString(7)));
            }
            reader.Close();

            // One resolution cache for the whole batch, not one per document — the same referenced
            // FormKey (a shared keyword, a race) recurs across a plugin's records, and every miss is a
            // form_lookup query of its own. Resolution is a pure lookup, so sharing changes nothing
            // about any single document's CheckErrors.
            var resolve = FormKeyResolutionCache.Memoize(owner.ResolveFormKey);

            var documents = new List<RecordDocument>(rows.Count);
            foreach (var row in rows)
            {
                // Same defensive skip as RederiveIndexRowsForRecord: a record_type no schema claims
                // has no reconstitution path.
                if (!schemas.TryGetValue(row.RecordType, out var schema)) continue;
                documents.Add(owner.DocumentFromBody(
                    row.FormKey, row.Plugin, row.Origin, row.LoadOrderIndex, row.IsWinner,
                    row.EditorId, row.Body, schema, resolve));
            }
            return documents;
        }

        public RecordOverrides? GetOverrideStack(string formKey)
        {
            owner.RequireSchemas(); // fail before touching the DB when Initialize hasn't run, matching every other read here
            var tableName = owner.FindRecordType(records, formKey);
            if (tableName == null) return null;
            var schema = owner.RequireSchemas()[tableName];
            using var cmd = owner.Connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, "ref"
                FROM {records}
                WHERE form_key = $1 AND record_type = $2
                ORDER BY load_order_idx
                """;
            cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
            cmd.Parameters.Add(new DuckDBParameter { Value = NormalizeRecordType(tableName) });
            using var reader = cmd.ExecuteReader();

            var resolve = FormKeyResolutionCache.Memoize(owner.ResolveFormKey);

            // Read the whole stack out before resolving any Head counterpart — ReadDocument opens
            // its own command on this same connection, and doing that while this reader is still open
            // would interleave two readers on one DuckDB connection.
            var rows = new List<(RecordDocument Document, bool IsDirty)>();
            while (reader.Read())
            {
                var doc = owner.ReadDocumentFromBody(reader, schema, resolve);
                // On a Head-scoped read every row is committed by construction, so this reads false
                // for all of them without needing to know which relation it is on.
                var isDirty = reader.GetString(7) == SourceRef.WorkingTree;
                rows.Add((doc, isDirty));
            }
            reader.Close();

            var entries = new List<OverrideStackEntry>();
            foreach (var (doc, isDirty) in rows)
            {
                // A clean entry keeps Head and Effective as the same instance — not merely equal
                // values — so "did this change" stays answerable by identity on the hot, overwhelmingly
                // common path. A dirty one resolves its committed counterpart from the Head relation.
                //
                // Deliberately `HeadRelation`, never this instance's own `records` field — a
                // dirty entry's committed counterpart lives at records_head regardless of which ref
                // *this* GetOverrideStack call is itself scoped to (Effective or Head), because Head
                // never has its own dirt to resolve a further Head-of-Head from. Do not "fix" this to
                // read `records`: that would make a Head-scoped GetOverrideStack call resolve a dirty
                // entry's committed body from itself, which is never dirty by construction, silently
                // losing the real committed text no test here would catch without the divergence this
                // exact line exists to serve (see RecordRefDivergenceTests).
                var head = isDirty
                    ? owner.ReadDocument(HeadRelation, tableName, doc.FormKey, doc.Plugin.Name, doc.Plugin.Origin, winnerOnly: false) ?? doc
                    : doc;
                entries.Add(new OverrideStackEntry(doc.Plugin, doc.LoadOrderIndex, doc.IsWinner, doc, head, isDirty));
            }

            return entries.Count == 0 ? null : new RecordOverrides(formKey, tableName, entries);
        }

        public PagedResult<RecordSummary> Search(RecordQuery query)
        {
            var (where, paramValues) = BuildWhere(
                query.Plugin?.Name, query.Search, owner._filterActive, query.Plugin?.Origin, query.RecordTypes);
            // "ref" plus a records_committed existence check is exactly the pair
            // RecordSummaryWorkingTreeStateTests pins — Modified is ref='working-tree' with a committed
            // snapshot on record; Added is the same ref with no snapshot at all (CreateWorkingTreeRecord's
            // own doc comment: a create writes nothing into records_committed). The `r` alias is needed
            // only for the correlated EXISTS below; `where`'s own unqualified column references still
            // resolve against it unambiguously, since it is the sole table this query's FROM names.
            // #560: has_container_children is the same correlated-EXISTS shape as
            // has_committed_snapshot just above, against container_child instead of
            // records_committed — container_child is never duplicated per ref (see
            // DuckDbRecordIndex.GetContainerChildren's own doc comment), so it's queried unqualified
            // here too, the same way that private method already does.
            const string cols = """
                form_key, plugin, load_order_idx, is_winner, editor_id, origin, r."ref",
                EXISTS (
                    SELECT 1 FROM records_committed rc
                    WHERE rc.form_key = r.form_key AND rc.plugin = r.plugin AND rc.origin = r.origin
                ) AS has_committed_snapshot,
                EXISTS (
                    SELECT 1 FROM container_child cc
                    WHERE cc.parent_form_key = r.form_key AND cc.plugin = r.plugin AND cc.origin = r.origin
                ) AS has_container_children
                """;

            using var countCmd = owner.Connection.CreateCommand();
            countCmd.CommandText = $"SELECT COUNT(*) FROM {records}{where}";
            AddParams(countCmd, paramValues);
            var total = (long)countCmd.ExecuteScalar()!;

            // editor_id alone is not unique — blank/duplicate EditorIDs are ordinary, and overrides
            // of one record across plugins share one by definition — so LIMIT/OFFSET paging over it with
            // no tiebreak lets DuckDB place tied rows on either side of a page boundary differently
            // across calls, silently skipping some and repeating others. (form_key, plugin, origin) is
            // this table's own identity (see CreateRecordsTable's doc comment), so appending it makes the
            // order total and paging stable.
            using var dataCmd = owner.Connection.CreateCommand();
            dataCmd.CommandText = $"""
                SELECT {cols} FROM {records} r{where}
                ORDER BY editor_id, form_key, plugin, origin
                LIMIT {query.Limit} OFFSET {query.Offset}
                """;
            AddParams(dataCmd, paramValues);

            var items = new List<RecordSummary>();
            using var reader = dataCmd.ExecuteReader();
            while (reader.Read())
                items.Add(ReadSummary(reader));

            return new PagedResult<RecordSummary>(items, (int)total);
        }

        // The filter narrows counts the same way it narrows listings (invariant: SetFilter affects
        // Search/counts/plugin-highlight, never a point read) — routed through the same BuildWhere every
        // other filterable query here uses, rather than a bespoke WHERE that would silently miss it.
        public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginKey plugin)
        {
            var (where, paramValues) = BuildWhere(plugin.Name, null, owner._filterActive, plugin.Origin, recordTypes: null);
            using var cmd = owner.Connection.CreateCommand();
            cmd.CommandText = $"SELECT record_type, COUNT(*) FROM {records}{where} GROUP BY record_type";
            AddParams(cmd, paramValues);
            using var reader = cmd.ExecuteReader();

            var counts = new List<RecordTypeCount>();
            while (reader.Read())
                counts.Add(new RecordTypeCount(reader.GetString(0), (int)reader.GetInt64(1)));
            return counts;
        }

        public RecordLookupEntry? Resolve(string formKey) => owner.ResolveFormKey(formKey);

        public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) => owner.GetReferences(targetFormKey);

        /// <summary>
        /// See <see cref="IRecordReads.GetEffectiveMasters"/> — derived, not declared. Union of (a) the
        /// owning plugin of every FormKey this plugin's records reference outward (<c>form_references</c>)
        /// and (b) the owning plugin of every FormKey this plugin carries that isn't native to it (an
        /// override forces that master), in deterministic load-order order, excluding the plugin itself.
        /// A master this plugin's header declares but nothing in it references or overrides is not
        /// effective, and is excluded — the ADR-0038 "effective masters" concept, reimplemented against
        /// the read model instead of a write-time content walk.
        /// </summary>
        public IReadOnlyList<string> GetEffectiveMasters(PluginKey plugin)
        {
            var required = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            using (var cmd = owner.Connection.CreateCommand())
            {
                cmd.CommandText = "SELECT DISTINCT target_form_key FROM form_references WHERE source_plugin = $1 AND source_origin = $2";
                cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Name });
                cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Origin });
                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    if (ModKeyNameOf(reader.GetString(0)) is { } name) required.Add(name);
                }
            }

            using (var cmd = owner.Connection.CreateCommand())
            {
                cmd.CommandText = $"SELECT DISTINCT form_key FROM {records} WHERE plugin = $1 AND origin = $2";
                cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Name });
                cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Origin });
                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    var fk = reader.GetString(0);
                    if (ModKeyNameOf(fk) is { } name && !string.Equals(name, plugin.Name, StringComparison.OrdinalIgnoreCase))
                        required.Add(name);
                }
            }

            required.Remove(plugin.Name);
            if (required.Count == 0) return [];

            // Deterministic load-order order: a master the load order holds sorts by its own
            // load_order_idx; one it doesn't (referenced but never registered, or registered with no
            // slot) falls after every listed master, alphabetically among themselves, so the result is
            // stable either way.
            var order = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            using (var cmd = owner.Connection.CreateCommand())
            {
                cmd.CommandText = $"SELECT plugin, MIN(load_order_idx) FROM {TableDdlBuilder.RegistrationsRelation} WHERE load_order_idx IS NOT NULL GROUP BY plugin";
                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                    order[reader.GetString(0)] = reader.GetInt32(1);
            }

            return [.. required
                .OrderBy(n => order.GetValueOrDefault(n, int.MaxValue))
                .ThenBy(n => n, StringComparer.OrdinalIgnoreCase)];
        }

        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames)
        {
            var types = tableNames.ToList();
            if (types.Count == 0 || !owner._filterActive)
                return new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            var (where, paramValues) = BuildWhere(null, null, filterActive: true, origin: null, recordTypes: types);

            using var cmd = owner.Connection.CreateCommand();
            cmd.CommandText = $"SELECT DISTINCT plugin FROM {records}{where}";
            AddParams(cmd, paramValues);
            using var reader = cmd.ExecuteReader();

            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (reader.Read())
                result.Add(reader.GetString(0));
            return result;
        }

        public IReadOnlyList<string> GetNativeFormKeys(PluginKey plugin)
        {
            // The header is excluded explicitly. It used to be excluded implicitly — it had no
            // document, so it was absent from `records` — but since #631 it is an ordinary row here,
            // and its synthetic 000000:<plugin> FormKey is not a record's: it names no record, and
            // the caller that computes the next free local FormID (RecordEditService) would be
            // handed a FormKey no record occupies. Harmless arithmetically (FormID 0 raises no
            // maximum) and wrong in kind, which is the reason it is filtered rather than tolerated.
            using var cmd = owner.Connection.CreateCommand();
            cmd.CommandText =
                $"SELECT DISTINCT form_key FROM {records} WHERE plugin = $1 AND origin = $2 AND record_type <> '{HeaderIndexer.RecordType}'";
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Name });
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Origin });
            using var reader = cmd.ExecuteReader();

            var result = new List<string>();
            while (reader.Read())
            {
                var fk = reader.GetString(0);
                var colon = fk.IndexOf(':');
                // "Native" = the record's own FormKey ModKey is this plugin (not an override of a master).
                if (colon > 0 && fk.AsSpan(colon + 1).Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
                    result.Add(fk);
            }
            return result;
        }

        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginKey plugin, string worldspaceFormKey)
        {
            using var cmd = owner.Connection.CreateCommand();
            // full_name is read straight out of the joined row's own JSON body rather than a
            // stored column the way editor_id is — this is the only consumer today, c.body is already
            // in scope on every relation {records} resolves to, and promoting it to a stored column
            // (mirroring editor_id's INSERT/UPDATE plumbing across every working-tree write path) is
            // easy to do later if a second consumer ever needs it. '$.Name.Value' is what the codec
            // emits for an *unlocalized* plugin's FULL subrecord (Mutagen's TranslatedString with a
            // direct string) — a localized plugin (STRINGS-backed, e.g. an official master) serializes
            // to '$.Name.Values' (a per-language array) instead, which this misses; the FULL name then
            // reads as absent and this falls back to the grid/EditorID label, same as a cell with no
            // FULL name at all, rather than surfacing the wrong string.
            cmd.CommandText = $"""
                SELECT cl.cell_form_key, c.editor_id, cl.block_x, cl.block_y, cl.sub_x, cl.sub_y, cl.grid_x, cl.grid_y,
                       json_extract_string(c.body, '$.Name.Value')
                FROM cell_location cl
                LEFT JOIN {records} c ON c.form_key = cl.cell_form_key AND c.plugin = cl.plugin AND c.origin = cl.origin
                WHERE cl.parent_worldspace = $1 AND cl.plugin = $2 AND cl.origin = $3
                ORDER BY cl.block_x, cl.block_y, cl.sub_x, cl.sub_y, cl.grid_x, cl.grid_y
                """;
            AddParams(cmd, [worldspaceFormKey, plugin.Name, plugin.Origin!]);
            using var reader = cmd.ExecuteReader();

            var rows = new List<CellLocationSummary>();
            while (reader.Read())
            {
                rows.Add(new CellLocationSummary(
                    reader.GetString(0),
                    reader.IsDBNull(1) ? null : reader.GetString(1),
                    reader.IsDBNull(2) ? null : reader.GetInt32(2),
                    reader.IsDBNull(3) ? null : reader.GetInt32(3),
                    reader.IsDBNull(4) ? null : reader.GetInt32(4),
                    reader.IsDBNull(5) ? null : reader.GetInt32(5),
                    reader.IsDBNull(6) ? null : reader.GetInt32(6),
                    reader.IsDBNull(7) ? null : reader.GetInt32(7),
                    reader.IsDBNull(8) ? null : reader.GetString(8)));
            }

            return rows;
        }

        public PagedResult<CellSummary> GetInteriorCells(PluginKey plugin, int limit, int offset)
        {
            using var countCmd = owner.Connection.CreateCommand();
            countCmd.CommandText = "SELECT COUNT(*) FROM cell_location WHERE is_interior AND plugin = $1 AND origin = $2";
            countCmd.Parameters.Add(new DuckDBParameter { Value = plugin.Name });
            countCmd.Parameters.Add(new DuckDBParameter { Value = plugin.Origin });
            var total = (long)countCmd.ExecuteScalar()!;

            // Same non-unique-ordering shape as Search's above — c.editor_id alone gives DuckDB no
            // tiebreak for LIMIT/OFFSET paging, so ties can land on either side of a page boundary
            // differently across calls. The WHERE clause already scopes this query to one plugin+origin,
            // so cl.cell_form_key alone (cell_location's own identity within that scope) is a sufficient
            // tiebreak — no need to repeat the already-constant plugin/origin columns.
            using var cmd = owner.Connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT cl.cell_form_key, c.editor_id, cl.grid_x, cl.grid_y
                FROM cell_location cl
                LEFT JOIN {records} c ON c.form_key = cl.cell_form_key AND c.plugin = cl.plugin AND c.origin = cl.origin
                WHERE cl.is_interior AND cl.plugin = $1 AND cl.origin = $2
                ORDER BY c.editor_id, cl.cell_form_key
                LIMIT {limit} OFFSET {offset}
                """;
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Name });
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Origin });
            using var reader = cmd.ExecuteReader();

            var items = new List<CellSummary>();
            while (reader.Read())
            {
                items.Add(new CellSummary(
                    reader.GetString(0),
                    reader.IsDBNull(1) ? null : reader.GetString(1),
                    reader.IsDBNull(2) ? null : reader.GetInt32(2),
                    reader.IsDBNull(3) ? null : reader.GetInt32(3)));
            }

            return new PagedResult<CellSummary>(items, (int)total);
        }

        public CellReferences GetCellReferences(PluginKey plugin, string cellFormKey)
        {
            var schemas = owner.RequireSchemas();
            var placedTypes = PlacedTableNames.Where(schemas.ContainsKey).ToList();
            if (placedTypes.Count == 0)
                return new CellReferences([], []);

            // ADR-0041: the placed ref's base form comes out of the document rather than a `base`
            // column; json_extract_string unquotes the stored FormLink text, and a placed ref with
            // no base at all reads NULL (RealDataReadGoldenTests.SpatialReads_MatchGolden pins this).
            var typeList = string.Join(", ", placedTypes.Select(t => $"'{t}'"));

            using var cmd = owner.Connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT p.placement_group, r.record_type, p.form_key, r.editor_id,
                       json_extract_string(r.body, '$.Base')
                FROM placement p
                JOIN {records} r ON r.form_key = p.form_key AND r.plugin = p.plugin AND r.origin = p.origin
                WHERE p.parent_cell = $1 AND p.plugin = $2 AND p.origin = $3
                  AND r.record_type IN ({typeList})
                ORDER BY r.editor_id
                """;
            AddParams(cmd, [cellFormKey, plugin.Name, plugin.Origin!]);
            using var reader = cmd.ExecuteReader();

            var persistent = new List<PlacedSummary>();
            var temporary = new List<PlacedSummary>();
            while (reader.Read())
            {
                var group = reader.GetString(0);
                var summary = new PlacedSummary(
                    reader.GetString(2),
                    reader.IsDBNull(3) ? null : reader.GetString(3),
                    reader.IsDBNull(4) ? null : reader.GetString(4),
                    reader.GetString(1));
                (group == "persistent" ? persistent : temporary).Add(summary);
            }
            return new CellReferences(persistent, temporary);
        }

        public PlacementRow? GetPlacement(string formKey, PluginKey plugin) =>
            owner.GetPlacement(formKey, plugin.Name, plugin.Origin!);

        public CellLocationRow? GetCellLocation(PluginKey plugin, string cellFormKey) =>
            owner.GetCellLocation(cellFormKey, plugin.Name, plugin.Origin!);

        public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginKey plugin, string parentFormKey) =>
            owner.GetContainerChildren(plugin.Name, plugin.Origin!, parentFormKey);

        public ContainerChildRow? GetContainerParent(PluginKey plugin, string childFormKey) =>
            owner.GetContainerParent(plugin.Name, plugin.Origin!, childFormKey);

        // Column 6 is "ref" (SourceRef.Committed/WorkingTree), column 7 is the correlated
        // records_committed EXISTS Search's SELECT list adds. None for the overwhelming majority (ref is
        // committed); Added/Modified come only from working-tree rows. Kept out of ReadSummary's
        // constructor call so the ref/snapshot→enum decision stays in C#, not duplicated as SQL
        // string literals ('modified'/'added') the reader would otherwise parse.
        private static WorkingTreeState ReadWorkingTreeState(DuckDBDataReader reader)
        {
            if (reader.GetString(6) != SourceRef.WorkingTree) return WorkingTreeState.None;
            return reader.GetBoolean(7) ? WorkingTreeState.Modified : WorkingTreeState.Added;
        }

        private static string? ModKeyNameOf(string formKey)
        {
            var colon = formKey.IndexOf(':');
            return colon > 0 ? formKey[(colon + 1)..] : null;
        }

        // Column 8 is the correlated container_child EXISTS Search's SELECT list adds (#560) —
        // read positionally, same as columns 6/7 above, rather than by name, matching this reader's
        // existing convention throughout.
        private static RecordSummary ReadSummary(DuckDBDataReader reader) =>
            new(reader.GetString(0), reader.GetString(1), LoadOrderSortKey(reader, 2),
                reader.GetBoolean(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetString(5),
                ReadWorkingTreeState(reader), reader.GetBoolean(8));

        // origin (ADR-0036): nullable and independent of plugin — a *filter*, not an identity
        // field. Defaults to "no constraint" so a plugin-only or filter-less call returns every
        // origin's rows.
        // recordTypes: empty/null means every type; one entry scopes a per-type listing; several a
        // multi-type search.
        private static (string where, List<string> paramValues) BuildWhere(
            string? plugin, string? search, bool filterActive = false, string? origin = null,
            IReadOnlyList<string>? recordTypes = null)
        {
            var conditions = new List<string>();
            var values = new List<string>();

            if (recordTypes is { Count: > 0 })
            {
                var placeholders = recordTypes.Select((_, i) => $"${values.Count + i + 1}");
                conditions.Add($"record_type IN ({string.Join(", ", placeholders)})");
                values.AddRange(recordTypes.Select(NormalizeRecordType));
            }

            if (plugin != null)
            {
                conditions.Add($"plugin = ${values.Count + 1}");
                values.Add(plugin);
            }
            if (origin != null)
            {
                conditions.Add($"origin = ${values.Count + 1}");
                values.Add(origin);
            }
            if (search != null)
            {
                // A FormKey-shaped query (e.g. seeded by the picker from the record's own
                // reference, or pasted) resolves directly against the exact stored form_key
                // rather than an EditorID substring match — form_key values are always stored via
                // Mutagen's own FormKey.ToString(), so round-tripping the query through
                // FormKey.TryFactory/.ToString() canonicalizes case/format to match. A query that merely
                // looks FormKey-ish but doesn't fully parse falls through to the EditorID match below,
                // same as always.
                if (Mutagen.Bethesda.Plugins.FormKey.TryFactory(search, out var formKey))
                {
                    // Case-insensitive: FormKey.TryFactory canonicalizes the hex id but does not
                    // re-case the ModKey (plugin) portion against known data, so a user-typed
                    // lowercase plugin name would otherwise miss an exact case-sensitive match.
                    conditions.Add($"LOWER(form_key) = LOWER(${values.Count + 1})");
                    values.Add(formKey.ToString());
                }
                else
                {
                    conditions.Add($"editor_id ILIKE ${values.Count + 1}");
                    values.Add($"%{search}%");
                }
            }
            if (filterActive)
                conditions.Add("form_key IN (SELECT form_key FROM _filter)");

            var where = conditions.Count > 0 ? " WHERE " + string.Join(" AND ", conditions) : "";
            return (where, values);
        }
    }

    public RecordDocument? GetDocument(string formKey) => At(RecordRef.Effective).GetDocument(formKey);

    public RecordDocument? GetDocument(string formKey, PluginKey plugin) =>
        At(RecordRef.Effective).GetDocument(formKey, plugin);

    public IReadOnlyList<RecordDocument> GetDocuments(PluginKey plugin) =>
        At(RecordRef.Effective).GetDocuments(plugin);

    public RecordOverrides? GetOverrideStack(string formKey) => At(RecordRef.Effective).GetOverrideStack(formKey);

    public PagedResult<RecordSummary> Search(RecordQuery query) => At(RecordRef.Effective).Search(query);

    public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginKey plugin) =>
        At(RecordRef.Effective).GetRecordTypeCounts(plugin);

    public RecordLookupEntry? Resolve(string formKey) => At(RecordRef.Effective).Resolve(formKey);

    public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) =>
        At(RecordRef.Effective).GetReferencedBy(targetFormKey);

    public IReadOnlyList<string> GetEffectiveMasters(PluginKey plugin) =>
        At(RecordRef.Effective).GetEffectiveMasters(plugin);

    public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) =>
        At(RecordRef.Effective).GetPluginsWithMatchingRecords(tableNames);

    public IReadOnlyList<string> GetNativeFormKeys(PluginKey plugin) =>
        At(RecordRef.Effective).GetNativeFormKeys(plugin);

    public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginKey plugin, string worldspaceFormKey) =>
        At(RecordRef.Effective).GetWorldspaceCells(plugin, worldspaceFormKey);

    public PagedResult<CellSummary> GetInteriorCells(PluginKey plugin, int limit, int offset) =>
        At(RecordRef.Effective).GetInteriorCells(plugin, limit, offset);

    public CellReferences GetCellReferences(PluginKey plugin, string cellFormKey) =>
        At(RecordRef.Effective).GetCellReferences(plugin, cellFormKey);

    public PlacementRow? GetPlacement(string formKey, PluginKey plugin) =>
        At(RecordRef.Effective).GetPlacement(formKey, plugin);

    public CellLocationRow? GetCellLocation(PluginKey plugin, string cellFormKey) =>
        At(RecordRef.Effective).GetCellLocation(plugin, cellFormKey);

    public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginKey plugin, string parentFormKey) =>
        At(RecordRef.Effective).GetContainerChildren(plugin, parentFormKey);

    public ContainerChildRow? GetContainerParent(PluginKey plugin, string childFormKey) =>
        At(RecordRef.Effective).GetContainerParent(plugin, childFormKey);
    private RecordDocument? ReadDocument(string records, string tableName, string formKey, string? plugin, string? origin, bool winnerOnly)
    {
        var schema = RequireSchemas()[tableName];
        var conditions = new List<string> { "form_key = $1" };
        var values = new List<string> { formKey };

        if (winnerOnly) conditions.Add("is_winner = true");
        if (plugin != null) { conditions.Add($"plugin = ${values.Count + 1}"); values.Add(plugin); }
        if (origin != null) { conditions.Add($"origin = ${values.Count + 1}"); values.Add(origin); }

        conditions.Add($"record_type = ${values.Count + 1}");
        values.Add(NormalizeRecordType(tableName));

        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body
            FROM {records} WHERE {string.Join(" AND ", conditions)}
            LIMIT 1
            """;
        AddParams(cmd, values);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;

        return ReadDocumentFromBody(reader, schema, FormKeyResolutionCache.Memoize(ResolveFormKey));
    }

    /// <summary>Reads a record's document row into a <see cref="RecordDocument"/>, reconstituted
    /// through <see cref="RecordTextCodec"/> and extracted via <see cref="BuildFields"/> — see
    /// that method's own doc comment for why the values match the SQL door's by
    /// construction.</summary>
    private RecordDocument ReadDocumentFromBody(
        DuckDBDataReader reader, RecordTableSchema schema, Func<string, RecordLookupEntry?> resolveFormKey) =>
        DocumentFromBody(
            reader.GetString(0), reader.GetString(1), reader.GetString(2), LoadOrderSortKey(reader, 3),
            reader.GetBoolean(4), reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.GetString(6), schema, resolveFormKey);

    // The construction half of ReadDocumentFromBody, split out so the bulk read can build
    // documents from rows it materialized before reconstituting any of them.
    private RecordDocument DocumentFromBody(
        string formKey, string plugin, string origin, int loadOrderIndex, bool isWinner,
        string? editorId, string body, RecordTableSchema schema,
        Func<string, RecordLookupEntry?> resolveFormKey)
    {
        var bytes = Encoding.UTF8.GetBytes(body);

        // The plugin header (#631). Its body is a real document like every other row's — the source
        // tree's root RecordData.json — but a ModHeader is not an IMajorRecordGetter, so neither the
        // per-record codec nor ColumnSpec.Extract can touch it. Read back through the whole-mod door
        // that produced it and extracted by this schema's own HeaderColumnExtract delegates, which are
        // the *same delegates* that used to fill the retired wide table's columns — so what the record
        // editor renders for a header is unchanged by construction, not by a second implementation
        // agreeing with the first.
        if (schema.HeaderColumnExtract is { } headerExtracts)
        {
            var mod = HeaderDocument.Read(bytes);
            return new RecordDocument(
                formKey, new PluginKey(plugin, origin), loadOrderIndex, isWinner, editorId, schema.TableName,
                body, BuildFields(schema, i => headerExtracts[i](mod), resolveFormKey, _release),
                // A ModHeader can neither carry the Partial Form flag nor ever be a type that could,
                // so both are false outright rather than probed — same answer the retired column
                // reader gave by defaulting them.
                IsPartialForm: false, IsPartialFormable: false);
        }

        var record = _codec.DeserializeFromBytesAsync(bytes, _release, schema.TableName).GetAwaiter().GetResult();

        return new RecordDocument(
            formKey, new PluginKey(plugin, origin), loadOrderIndex, isWinner, editorId, schema.TableName,
            body, BuildFields(schema, i => schema.RecordColumns[i].Extract(record), resolveFormKey, _release),
            PartialFormFlag.IsSet(record), PartialFormFlag.IsPartialFormable(record.GetType()));
    }

    /// <summary>
    /// The field-extraction walk every reconstitution path shares — turns one raw per-column value
    /// into the <see cref="FieldValue"/> the read model serves, the shape both
    /// <see cref="ReadDocumentFromBody"/> and (via <c>RecordQueryService.ToRecordDetail</c>-adjacent
    /// callers) the rest of the read model build on.
    ///
    /// <para>The record is reconstituted through <see cref="RecordTextCodec"/> and then read by the
    /// <b>same <see cref="ColumnSpec.Extract"/> delegates</b> that fill the generated views. That is
    /// what makes the values identical by construction rather than by a second implementation
    /// agreeing with the first — and it is why the published relational schema can be the SQL door's
    /// contract without also being the C# surface's (invariant 8): the document body is Mutagen's
    /// serializer shape, which has no per-column correspondence to the reflected schema at all
    /// (defaults omitted, translated strings as objects, flags as name arrays, and the widened and
    /// split columns with no JSON path whatsoever).</para>
    ///
    /// <para><paramref name="rawAt"/> rather than the record itself, because the plugin header's
    /// values come from a different delegate family over a different object
    /// (<c>RecordTableSchema.HeaderColumnExtract</c> over an <c>IModGetter</c>, since a ModHeader is
    /// not an <see cref="IMajorRecord"/>). Everything past that one call is deliberately shared: the
    /// normalizations below are what a field's rendered shape actually depends on, so letting the
    /// header have its own copy of them is exactly how the two would drift.</para>
    ///
    /// <para>Each extracted value then passes through two normalizations, so a field's JSON keeps a
    /// stable shape: coerced to the column's declared DuckDB type (<see cref="CoerceToColumnType"/>),
    /// and bitmasks rendered as decimal strings.</para>
    /// </summary>
    /// <param name="schema">The record type's schema; <paramref name="rawAt"/> is indexed against its
    /// <see cref="RecordTableSchema.RecordColumns"/>.</param>
    /// <param name="rawAt">This column's raw value, by column position.</param>
    /// <param name="resolveFormKey">FormKey resolution, for the check-error pass.</param>
    /// <param name="release">The game release, for the check-error pass.</param>
    private static List<FieldValue> BuildFields(
        RecordTableSchema schema, Func<int, object?> rawAt,
        Func<string, RecordLookupEntry?> resolveFormKey, GameRelease release)
    {
        var fields = new List<FieldValue>();
        for (int i = 0; i < schema.RecordColumns.Count; i++)
        {
            var col = schema.RecordColumns[i];
            var raw = CoerceToColumnType(rawAt(i), col.DuckDbType);

            var isJsonText = col.IsArray || col.SubFields != null;
            object? value = raw switch
            {
                null => null,
                string text when isJsonText => JsonSerializer.Deserialize<JsonElement>(text),
                _ => raw,
            };

            if (value != null && col.IsBitmask)
                value = Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);

            var meta = col.ToFieldMetadata();
            fields.Add(new FieldValue(meta, value, CheckErrorBuilder.Build(meta, value, resolveFormKey, release)));
        }
        return fields;
    }

    // One lookup, over one relation: since #631 the plugin header is an ordinary `records` row, so
    // Open Header's synthetic 000000:<plugin> FormKey resolves here the same way every other FormKey
    // does — where it used to need a second query against a table of its own.
    //
    // Private — table-name dispatch is explicitly rejected from the seam; GetDocument and
    // GetOverrideStack resolve a FormKey's type themselves rather than being told it.
    private string? FindRecordType(string records, string formKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT record_type FROM {records} WHERE form_key = $1 LIMIT 1";
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        return cmd.ExecuteScalar() as string;
    }

    // Private — Resolve(formKey) is the public seam member and delegates here.
    private RecordLookupEntry? ResolveFormKey(string formKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = "SELECT record_type, editor_id FROM form_lookup WHERE form_key = $1 AND is_winner LIMIT 1";
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        using var reader = cmd.ExecuteReader();

        // Local function so the merged conditional expression below doesn't nest a ternary per
        // coordinate (SonarS3358), matching GetPlacement's NullableFloat pattern.
        string? NullableEditorId() => reader.IsDBNull(1) ? null : reader.GetString(1);

        return !reader.Read()
            ? null
            : new RecordLookupEntry(reader.GetString(0), NullableEditorId());
    }

    private static int LoadOrderSortKey(DuckDBDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? int.MaxValue : reader.GetInt32(ordinal);

    // A column declared INTEGER must read back an int no matter whether its extractor produced a
    // byte, ushort or uint. Reconstitution has no column type to do the narrowing, so the conversion
    // is applied here — without it a field's JSON would silently change numeric shape for every
    // sub-int type.
    private static object? CoerceToColumnType(object? value, string duckDbType)
    {
        if (value == null) return null;
        return duckDbType switch
        {
            "BOOLEAN" => Convert.ToBoolean(value, CultureInfo.InvariantCulture),
            "INTEGER" => Convert.ToInt32(value, CultureInfo.InvariantCulture),
            "BIGINT" => Convert.ToInt64(value, CultureInfo.InvariantCulture),
            "FLOAT" => Convert.ToSingle(value, CultureInfo.InvariantCulture),
            "DOUBLE" => Convert.ToDouble(value, CultureInfo.InvariantCulture),
            "VARCHAR" => value.ToString(),
            _ => value,
        };
    }

    // Record types used to be table names, and DuckDB resolves those case-insensitively — so callers
    // have always been free to say "NPC_" or "npc_" and several do. As a column value the comparison
    // is case-*sensitive*, which would silently return nothing for the same call that used to work.
    // Schema keys are produced by RecordType.Type.ToLowerInvariant(), so lowercasing the caller's
    // value is an exact normalization, not a guess. Applied at every point a caller-supplied type is
    // bound as a parameter.
    private static string NormalizeRecordType(string recordType) => recordType.ToLowerInvariant();

    private static void AddParams(DuckDBCommand cmd, IEnumerable<string> values)
    {
        foreach (var v in values)
            cmd.Parameters.Add(new DuckDBParameter { Value = v });
    }


    private void Execute(string sql)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private IReadOnlyDictionary<string, RecordTableSchema> RequireSchemas() =>
        _schemas ?? throw new InvalidOperationException("Call Initialize before using the repository.");

    private List<ReferenceResult> GetReferences(string targetFormKey)
    {
        // ADR-0041: a reference is what the indexed plugin actually declares — no working-tree
        // overlay is applied here.
        const string sql = """
            SELECT fr.source_form_key, fr.source_plugin, fr.field_path, fr.record_type, fr.editor_id, fr.source_origin
            FROM form_references fr
            WHERE fr.target_form_key = $1
            """;

        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        AddParams(cmd, [targetFormKey]);

        var results = new List<ReferenceResult>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            results.Add(new ReferenceResult(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.GetString(5)));
        }

        return results;
    }

    // ── Worldspace tree reads (ADR-0023) ────────────────────────────────────────

    private PlacementRow? GetPlacement(string formKey, string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT parent_cell, placement_group, pos_x, pos_y, pos_z
            FROM placement
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """;
        AddParams(cmd, [formKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        // Local function so the merged conditional expression below doesn't nest a ternary per
        // coordinate (SonarS3358) while still collapsing the guard clause per IDE0046.
        float? NullableFloat(int i) => reader.IsDBNull(i) ? null : reader.GetFloat(i);

        return !reader.Read()
            ? null
            : new PlacementRow(
                formKey,
                reader.GetString(0),
                reader.GetString(1),
                NullableFloat(2),
                NullableFloat(3),
                NullableFloat(4));
    }

    private CellLocationRow? GetCellLocation(string cellFormKey, string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT parent_worldspace, block_x, block_y, sub_x, sub_y, grid_x, grid_y, is_interior
            FROM cell_location
            WHERE cell_form_key = $1 AND plugin = $2 AND origin = $3
            """;
        AddParams(cmd, [cellFormKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        int? NullableInt(int i) => reader.IsDBNull(i) ? null : reader.GetInt32(i);
        if (!reader.Read()) return null;

        var parentWorldspace = reader.IsDBNull(0) ? null : reader.GetString(0);
        return new CellLocationRow(
            cellFormKey, parentWorldspace,
            NullableInt(1), NullableInt(2), NullableInt(3), NullableInt(4), NullableInt(5), NullableInt(6),
            reader.GetBoolean(7));
    }

    private List<ContainerChildRow> GetContainerChildren(string plugin, string origin, string parentFormKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT child_form_key, parent_record_type, slot_name, slot_index
            FROM container_child
            WHERE parent_form_key = $1 AND plugin = $2 AND origin = $3
            ORDER BY slot_name, slot_index
            """;
        AddParams(cmd, [parentFormKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        var result = new List<ContainerChildRow>();
        while (reader.Read())
        {
            result.Add(new ContainerChildRow(
                reader.GetString(0), parentFormKey, reader.GetString(1), reader.GetString(2), reader.GetInt32(3)));
        }
        return result;
    }

    /// <summary>See <see cref="IRecordReads.GetContainerParent"/>. Ref-invariant for the same reason
    /// its inverse is, so it likewise ignores which relation the caller is positioned on.</summary>
    private ContainerChildRow? GetContainerParent(string plugin, string origin, string childFormKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT parent_form_key, parent_record_type, slot_name, slot_index
            FROM container_child
            WHERE child_form_key = $1 AND plugin = $2 AND origin = $3
            """;
        AddParams(cmd, [childFormKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        return reader.Read()
            ? new ContainerChildRow(
                childFormKey, reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetInt32(3))
            : null;
    }

    public void ReplaceContainerChildSlot(
        PluginKey key, string parentFormKey, string parentRecordType, string slotName,
        IReadOnlyList<(string ChildFormKey, int SlotIndex)> children)
    {
        DuckDbSql.ExecuteFor(Connection,
            """
            DELETE FROM mirror.container_child
            WHERE parent_form_key = $1 AND slot_name = $2 AND plugin = $3 AND origin = $4
            """,
            parentFormKey, slotName, key.Name, key.Origin!);

        if (children.Count == 0) return;

        using var appender = Connection.CreateAppender("mirror", "container_child");
        foreach (var (childFormKey, slotIndex) in children)
        {
            PluginIngest.AppendContainerChildRow(
                appender,
                new ContainerChildRow(childFormKey, parentFormKey, parentRecordType, slotName, slotIndex),
                key.Name, key.Origin!);
        }
    }

    /// <summary>See <see cref="IRecordIndex.RepointContainerChildParent"/>.</summary>
    public void RepointContainerChildParent(PluginKey key, string oldParentFormKey, string newParentFormKey) =>
        DuckDbSql.ExecuteFor(Connection,
            """
            UPDATE mirror.container_child SET parent_form_key = $1
            WHERE parent_form_key = $2 AND plugin = $3 AND origin = $4
            """,
            newParentFormKey, oldParentFormKey, key.Name, key.Origin!);

    /// <summary>See <see cref="IRecordIndex.RepointCellLocationParent"/>.</summary>
    public void RepointCellLocationParent(PluginKey key, string oldParentFormKey, string newParentFormKey) =>
        DuckDbSql.ExecuteFor(Connection,
            """
            UPDATE mirror.cell_location SET parent_worldspace = $1
            WHERE parent_worldspace = $2 AND plugin = $3 AND origin = $4
            """,
            newParentFormKey, oldParentFormKey, key.Name, key.Origin!);

    /// <summary>See <see cref="IRecordIndex.CreateCellLocation"/>.</summary>
    public void CreateCellLocation(PluginKey plugin, CellLocationRow row)
    {
        DuckDbSql.ExecuteFor(Connection, "DELETE FROM mirror.cell_location WHERE cell_form_key = $1 AND plugin = $2 AND origin = $3",
            row.CellFormKey, plugin.Name, plugin.Origin!);
        using var appender = Connection.CreateAppender("mirror", "cell_location");
        PluginIngest.AppendCellLocationRow(appender, row, plugin.Name, plugin.Origin!);
    }

    public void SetFilter(string? sql)
    {
        if (sql is null)
        {
            _filterActive = false;
            return;
        }

        using var probeCmd = Connection.CreateCommand();
        probeCmd.CommandText = $"SELECT * FROM ({sql}) __probe LIMIT 0";
        using var probeReader = probeCmd.ExecuteReader();
        bool hasFormKey = Enumerable.Range(0, probeReader.FieldCount)
            .Any(i => string.Equals(probeReader.GetName(i), "form_key", StringComparison.OrdinalIgnoreCase));

        if (!hasFormKey)
            throw new ArgumentException("Filter SQL must return a form_key column");

        Execute($"CREATE OR REPLACE TABLE _filter AS ({sql})");
        _filterActive = true;
    }

    public void Dispose() => Connection.Dispose();
}
