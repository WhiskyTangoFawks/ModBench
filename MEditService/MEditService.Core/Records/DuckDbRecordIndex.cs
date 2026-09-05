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

// The single DuckDB implementation of IRecordIndex/IRecordReads, split into three collaborators:
// IndexStore, PluginIngest and WorkingTreeOverlay. This class owns every transaction boundary,
// registration, the winner sweep, reads and the SQL door.
public sealed class DuckDbRecordIndex : IRecordIndex
{
    private readonly SchemaReflector _schemaReflector;
    private readonly ILogger _logger;
    private IReadOnlyDictionary<string, RecordTableSchema>? _schemas;
    private readonly PlacementWalker _placementWalker = new();
    private static readonly string[] PlacedTableNames = ["refr", "achr"];
    private bool _filterActive;

    // ADR-0041: the per-record source codec. Constructed rather than injected: it is stateless apart
    // from static reflection caches, and every construction site would otherwise learn a dependency
    // it has no say in.
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);

    // Connection forwards to IndexStore rather than being held here, so a rebuild that reassigns its
    // Connection is transparent to every `.Connection` reader.
    private readonly IndexStore _indexStore;

    // Constructed at the end of Initialize, once Connection is stable and the schemas and release
    // are resolved, so every dependency is captured once rather than chased through a mutable
    // back-reference.
    private PluginIngest _pluginIngest = null!;

    // Constructed after _pluginIngest, for the same reason and because it depends on PluginIngest
    // one-directionally.
    private WorkingTreeOverlay _workingTreeOverlay = null!;

    public DuckDBConnection Connection => _indexStore.Connection;

    private readonly TableDdlBuilder _ddlBuilder;
    private bool _recordTypeViewsCreated;

    public DuckDbRecordIndex(
        SchemaReflector schemaReflector,
        TableDdlBuilder ddlBuilder,
        ILogger logger,
        string? databasePath = null)
    {
        _schemaReflector = schemaReflector;
        _ddlBuilder = ddlBuilder;
        _logger = logger;
        _indexStore = new IndexStore(logger, databasePath);
    }

    // The SQL door's per-type views, created on the first filter rather than at Initialize (ADR-0005).
    internal void CreateRecordTypeViews()
    {
        if (_recordTypeViewsCreated) return;
        _ddlBuilder.CreateRecordTypeViews(Connection, _release);
        _recordTypeViewsCreated = true;
    }

    // Reading a record back out of its document needs the release it was written under, and this
    // repository is one game for its whole lifetime — the same reasoning that resolves the schemas
    // once, here.
    private GameRelease _release;

    public void Initialize(GameRelease release)
    {
        var indexVersion = IndexVersion.For(_schemaReflector, release);
        // Before the schemas, not after: IndexStore's own version check throws away a file written
        // under a different shape *before* this process starts appending to tables it only half
        // recognizes.
        _indexStore.Initialize(indexVersion);

        _schemas = _schemaReflector.GetSchemas(release);
        _release = release;

        _pluginIngest = new PluginIngest(Connection, _logger, _codec, _placementWalker);
        _workingTreeOverlay = new WorkingTreeOverlay(
            Connection, _logger, _codec, _placementWalker, release, _schemas);

        // Unindex is this class's cross-cutting verb (registration plus every ingest-owned table), so
        // acting on the stale set stays here.
        foreach (var key in _indexStore.ValidateAgainstDisk())
            Unindex(key);
    }

    // --- Indexing ---

    public void Index(IModGetter plugin, Registration registration, PluginKey key, string? filePath = null) =>
        Index(plugin, registration, key.Origin!, filePath);

    /// <summary>See <see cref="IRecordIndex.IndexedContentHash"/>.</summary>
    public string? IndexedContentHash(PluginKey key) => _indexStore.IndexedContentHash(key);

    // ADR-0036: origin is threaded into every per-plugin delete/upsert/append so a plugin is
    // identified by (origin, plugin) together, never filename alone.
    private void Index(IModGetter pluginMod, Registration registration, string origin, string? filePath)
    {
        var schemas = RequireSchemas();
        var plugin = pluginMod.ModKey.FileName.ToString();

        // One transaction for the whole reindex so a throw partway leaves the read model intact
        // rather than a partial snapshot. DuckDB appenders enroll in the active transaction, so
        // deletes and appender flushes roll back together on Dispose-without-Commit.
        using var tx = Connection.BeginTransaction();

        // One `registrations` row per indexed plugin — UpdateWinners() joins against it so a
        // non-participating copy's rows never win regardless of load_order_idx.
        UpsertRegistration(plugin, origin, registration);
        // And the disk claim these rows are about, replaced with them rather than beside them.
        _indexStore.StampIndexedFile(plugin, origin, filePath);

        // Must run before the appender is created.
        _pluginIngest.DeletePriorDocuments(plugin, origin);

        // The appender's `using` stays here so its disposal keeps the required ordering relative to
        // tx.Commit() below: tx declared first, appender second, both disposed LIFO after the commit.
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

    // The `registrations` row is dropped last: it is the row UpdateWinners joins against, and while
    // it exists this (origin, plugin) is still a known member of the read model.
    private void Unindex(string plugin, string origin)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Unindexing {Plugin} from {Origin}", plugin, origin);
        }
        using var tx = Connection.BeginTransaction();

        _pluginIngest.DeleteAllRowsFor(plugin, origin);
        // The file claim goes with the rows it describes — Unindex is the file-gone verb, so leaving
        // it behind would leave the mirror asserting rows the index does not hold.
        _indexStore.DeleteIndexedFile(plugin, origin);
        DeleteRegistration(plugin, origin);

        tx.Commit();
    }

    // ADR-0035: one row per registered copy. ADR-0044: participation is derived from the three facts
    // here (TableDdlBuilder.ParticipatesPredicate), never a column.
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

    // ADR-0001: registration is visibility. Every public relation is a view over its `mirror.` table
    // joined to this row, so writing or deleting the row makes a plugin's rows answer or fall
    // silent; neither verb touches a data row.
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

    /// <summary>Wholesale rather than incremental because there is no smaller correct unit:
    /// registering a plugin can move the winner of every FormKey it holds. Measured at ~75 ms for
    /// both refs on a 48,000-record, 60-plugin fixture.</summary>
    public void UpdateWinners()
    {
        Execute($"DELETE FROM {TableDdlBuilder.WinnersRelation}");

        // Effective, one relation: the header is an ordinary `records` row, swept here by
        // construction. form_lookup gets no branch: ADR-0031 keeps one lookup row per Effective
        // record row, so `records`' winners are form_lookup's.
        InsertWinners(RecordRef.Effective, "SELECT form_key, plugin, origin FROM mirror.records");

        // Head, over the same membership relation records_head itself is built on. A record the
        // working tree deleted is gone from Effective but still held at Head, so the two stacks can
        // name different winners for one FormKey.
        InsertWinners(RecordRef.Head, $"SELECT form_key, plugin, origin FROM {TableDdlBuilder.HeadRowsRelation}");
    }

    // The winner rule: among the rows, the participating plugin latest in the load order wins its
    // FormKey. QUALIFY makes the result a function — a tie on load_order_idx yields one winner —
    // and the (plugin, origin) tiebreak makes which one deterministic.
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
    /// batch, so a throw partway cannot leave Effective and Head disagreeing about which records
    /// diverged.</summary>
    public void ApplyWorkingTreeChanges(PluginKey key, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        if (deltas.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        // Only a delta that added or removed a row can move winner status. Re-swept for the whole
        // load order rather than per FormKey because UpdateWinners is the one definition of winning
        // (measured at 18 ms over 48k records).
        if (_workingTreeOverlay.ApplyWorkingTreeChanges(key, deltas)) UpdateWinners();
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.CreateWorkingTreeRecord"/>.</summary>
    public void CreateWorkingTreeRecord(PluginKey key, string formKey, string recordType, string body)
    {
        ThrowIfHeldAtEitherRef(key, formKey, nameof(CreateWorkingTreeRecord), nameof(formKey));

        using var tx = Connection.BeginTransaction();
        _workingTreeOverlay.CreateWorkingTreeRecord(key, formKey, recordType, body);
        // A create is always structural — a row that did not exist at Effective now does — so this
        // always resweeps, the same trigger ApplyWorkingTreeChanges's own structural deltas use.
        UpdateWinners();
        tx.Commit();
    }

    // Made before either caller opens a transaction: a collision is a caller mistake, and answering
    // it costs no rollback.
    private void ThrowIfHeldAtEitherRef(PluginKey key, string formKey, string verb, string parameterName)
    {
        if (_workingTreeOverlay.RowExistsAtEffective(key, formKey) || _workingTreeOverlay.RowExistsAtHead(key, formKey))
        {
            throw new ArgumentException(
                $"{key.Name} ({key.Origin}) already holds {formKey} at some ref — {verb} " +
                "is only for a FormKey neither ref answers to.", parameterName);
        }
    }

    /// <summary>See <see cref="IRecordIndex.ApplyRenumber"/>. Every write below runs unwrapped on the
    /// connection and so joins the one transaction opened here: the sequence commits once or not at
    /// all.</summary>
    public void ApplyRenumber(PluginKey key, RenumberedRecord renumbered)
    {
        var (oldFormKey, newFormKey, recordType, body, owner) = renumbered;
        ThrowIfHeldAtEitherRef(key, newFormKey, nameof(ApplyRenumber), nameof(renumbered));

        using var tx = Connection.BeginTransaction();

        // An embedded record's owner was reserialized around the child's new FormKey; picking those
        // bytes up also re-derives the child's containment, so that shape needs no re-point. First,
        // matching the order the source write uses.
        if (owner is { } embedding)
            _workingTreeOverlay.ApplyWorkingTreeChanges(key, [(embedding.FormKey, embedding.Body)]);

        _workingTreeOverlay.CreateWorkingTreeRecord(key, newFormKey, recordType, body);

        if (owner is null)
        {
            // Before the old identity's rows are torn down below, so the children re-pointed here are
            // never left naming a parent that does not exist. Re-deriving the new document cannot
            // reach either of these.
            RepointContainerChildParent(key, oldFormKey, newFormKey);
            RepointCellLocationParent(key, oldFormKey, newFormKey);
        }

        _workingTreeOverlay.ApplyWorkingTreeChanges(key, [(oldFormKey, null)]);

        // Once, at the end: the sequence both creates an Effective row and removes one, so it is
        // structural either way, and UpdateWinners re-sweeps the whole load order regardless.
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
        // Effective is untouched, but Head just lost a row per FormKey, which can promote the next
        // plugin down at that ref; Head's winners are swept, not derived per read (ADR-0001).
        UpdateWinners();
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.SeedCommittedOnly"/>. One transaction for the whole batch:
    /// the three head-state writes are all-or-nothing together, so a throw partway through a
    /// reconciliation pass cannot leave half of one applied.</summary>
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

    // `records` holds one row per record copy and that row is Effective, so every read reaches its
    // ref by naming a relation of the same shape; no read carries a ref predicate.
    private const string EffectiveRelation = "records";
    private const string HeadRelation = "records_head";

    // Created on first ask and reused: each is a stateless projection over this same connection, and
    // At() is called per read on hot paths.
    private IRecordReads? _effectiveReads;
    private IRecordReads? _headReads;

    /// <summary>Reads answering from the extracted tables (<c>Resolve</c>, <c>GetReferencedBy</c>,
    /// <c>GetPlacement</c>) are identical at both refs: those tables carry no ref dimension and
    /// track Effective. The public surface is <c>At(Effective)</c>.</summary>
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

    // The one implementation of every IRecordReads member, parameterized by which relation its SQL
    // names, so a read cannot be ref-aware on one path and not the other.
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

        // One query rather than two point queries per record. Rows are materialized before
        // reconstitution: resolving a FormKey opens its own command on this connection, which would
        // interleave two readers.
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

            // One resolution cache for the whole batch: the same referenced FormKey recurs across a
            // plugin's records, and every miss is a form_lookup query. Resolution is a pure lookup, so
            // sharing changes nothing.
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
                // A clean entry keeps Head and Effective as the same instance, so "did this change" is
                // answerable by identity. Deliberately `HeadRelation`, never `records`: a dirty entry's
                // committed counterpart lives at records_head whichever ref this call is scoped to.
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
            // Modified is ref='working-tree' with a committed snapshot; Added is the same ref with no
            // snapshot (a create writes nothing into records_committed). has_container_children is the
            // same correlated-EXISTS shape against container_child, which is never duplicated per ref.
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

            // editor_id alone is not unique — blank and duplicate EditorIDs are ordinary — so
            // LIMIT/OFFSET over it alone lets DuckDB place tied rows on either side of a page boundary
            // differently across calls. (form_key, plugin, origin) makes the order total.
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
        // Search/counts/plugin-highlight, never a point read), routed through the same BuildWhere
        // every other filterable query here uses.
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

        /// <summary>Derived, not declared (ADR-0038): owners of every outward reference plus owners
        /// of every non-native FormKey this plugin carries, in load order, excluding itself.</summary>
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

            // A master the load order holds sorts by its load_order_idx; one it doesn't falls after
            // every listed master, alphabetically among themselves, so the result is stable either way.
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
            // The header is excluded explicitly: its synthetic 000000:<plugin> FormKey names no record,
            // and the caller that computes the next free local FormID would be handed a FormKey no
            // record occupies.
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
            // full_name is read from the joined row's JSON. '$.Name.Value' is what the codec emits for
            // an unlocalized plugin's FULL; a localized plugin serializes '$.Name.Values' instead, which
            // this misses, falling back to the grid/EditorID label.
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

            // Same non-unique-ordering shape as Search: c.editor_id alone gives no tiebreak for
            // LIMIT/OFFSET. The WHERE already scopes to one plugin+origin, so cl.cell_form_key alone is
            // a sufficient tiebreak.
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
            // column; json_extract_string unquotes the stored FormLink text, and a placed ref with no
            // base reads NULL.
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

        // Column 6 is "ref", column 7 the correlated records_committed EXISTS Search's SELECT adds.
        // Decided in C# rather than as SQL string literals the reader would parse.
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

        // Column 8 is the correlated container_child EXISTS Search's SELECT adds, read positionally
        // like columns 6/7.
        private static RecordSummary ReadSummary(DuckDBDataReader reader) =>
            new(reader.GetString(0), reader.GetString(1), LoadOrderSortKey(reader, 2),
                reader.GetBoolean(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetString(5),
                ReadWorkingTreeState(reader), reader.GetBoolean(8));

        // origin (ADR-0036): nullable and independent of plugin — a *filter*, not an identity field.
        // Defaults to "no constraint" so a plugin-only or filter-less call returns every origin's rows.
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
                // A FormKey-shaped query resolves against the exact stored form_key rather than an
                // EditorID substring match; form_key values are stored via FormKey.ToString(), so
                // round-tripping the query through TryFactory canonicalizes it.
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

    private RecordDocument ReadDocumentFromBody(
        DuckDBDataReader reader, RecordTableSchema schema, Func<string, RecordLookupEntry?> resolveFormKey) =>
        DocumentFromBody(
            reader.GetString(0), reader.GetString(1), reader.GetString(2), LoadOrderSortKey(reader, 3),
            reader.GetBoolean(4), reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.GetString(6), schema, resolveFormKey);

    // The construction half of ReadDocumentFromBody, split out so the bulk read can build
    // documents from rows it materialized before reading any of them. The fields are the
    // document's own nodes at each column's path (ADR-0032): nothing is reconstituted or projected.
    private RecordDocument DocumentFromBody(
        string formKey, string plugin, string origin, int loadOrderIndex, bool isWinner,
        string? editorId, string body, RecordTableSchema schema,
        Func<string, RecordLookupEntry?> resolveFormKey)
    {
        using var parsed = JsonDocument.Parse(body);
        var root = parsed.RootElement;

        return new RecordDocument(
            formKey, new PluginKey(plugin, origin), loadOrderIndex, isWinner, editorId, schema.TableName,
            body, BuildFields(schema, root, resolveFormKey, _release),
            // A ModHeader can neither carry the Partial Form flag nor be a type that could.
            IsPartialForm: !schema.IsHeader && PartialFormFlag.IsSet(root, schema.RecordType),
            IsPartialFormable: !schema.IsHeader && PartialFormFlag.IsPartialFormable(schema.RecordType));
    }

    private static List<FieldValue> BuildFields(
        RecordTableSchema schema, JsonElement root,
        Func<string, RecordLookupEntry?> resolveFormKey, GameRelease release)
    {
        var fields = new List<FieldValue>(schema.RecordColumns.Count);
        foreach (var col in schema.RecordColumns)
        {
            var value = DocumentNodes.At(root, col.PropertyName);
            var meta = col.ToFieldMetadata();
            // The check reads the shape this record's own class gives the column; the wire keeps the
            // column's whole metadata, variants included, so the editor can pick the same.
            fields.Add(new FieldValue(meta, value, CheckErrorBuilder.Build(DocumentNodes.VariantFor(meta, root), value, resolveFormKey, release)));
        }
        return fields;
    }

    // Private: table-name dispatch is rejected from the seam; GetDocument and GetOverrideStack
    // resolve a FormKey's type themselves rather than being told it.
    private string? FindRecordType(string records, string formKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT record_type FROM {records} WHERE form_key = $1 LIMIT 1";
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        return cmd.ExecuteScalar() as string;
    }

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

    // Callers say both "NPC_" and "npc_", and as a column value the comparison is case-sensitive.
    // Schema keys are RecordType.Type.ToLowerInvariant(), so lowercasing is an exact normalization,
    // applied wherever a caller-supplied type is bound.
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

    // Ref-invariant for the same reason its inverse is, so it ignores which relation the caller is
    // positioned on.
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

    // An UPDATE, not a delete-then-rebuild: the children did not move, only the identity they name.
    // Runs unwrapped, inside ApplyRenumber's transaction.
    private void RepointContainerChildParent(PluginKey key, string oldParentFormKey, string newParentFormKey) =>
        DuckDbSql.ExecuteFor(Connection,
            """
            UPDATE mirror.container_child SET parent_form_key = $1
            WHERE parent_form_key = $2 AND plugin = $3 AND origin = $4
            """,
            newParentFormKey, oldParentFormKey, key.Name, key.Origin!);

    // The same shape for an exterior cell's parent_worldspace, the sibling gap the row above cannot
    // cover; runs inside ApplyRenumber's transaction.
    private void RepointCellLocationParent(PluginKey key, string oldParentFormKey, string newParentFormKey) =>
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

        CreateRecordTypeViews();
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
