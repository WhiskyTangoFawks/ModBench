using System.Data;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceRepo;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Index;

// The single DuckDB implementation of IRecordIndex/IRecordReads, split into four collaborators:
// IndexStore, PluginIngest, WorkingTreeOverlay and SourceValidation. This class owns every
// transaction boundary, registration, the winner sweep, reads and the SQL door.
internal sealed class DuckDbRecordIndex : IRecordIndex
{
    private readonly SchemaReflector _schemaReflector;
    private readonly ILogger _logger;
    private IReadOnlyDictionary<string, RecordTableSchema>? _schemas;
    private static readonly string[] PlacedTableNames = ["refr", "achr"];
    private bool _filterActive;

    // ADR-0007: the per-record source codec. Constructed rather than injected: it is stateless apart
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

    // Validate's tracked half. Constructed alongside its siblings, for the same reason.
    private SourceValidation _sourceValidation = null!;

    public DuckDBConnection Connection => _indexStore.Connection;
    private DuckDBConnection OpenRead() => _indexStore.OpenReadConnection();

    private readonly TableDdlBuilder _ddlBuilder;
    private bool _recordTypeViewsCreated;

    // ADR-0014: null in every test that does not care, so this stays additive over the 55 direct
    // constructions across the suite.
    private readonly INotificationPublisher? _notifications;

    public DuckDbRecordIndex(
        SchemaReflector schemaReflector,
        TableDdlBuilder ddlBuilder,
        ILogger logger,
        string? databasePath = null,
        INotificationPublisher? notifications = null)
    {
        _schemaReflector = schemaReflector;
        _ddlBuilder = ddlBuilder;
        _logger = logger;
        _notifications = notifications;
        _indexStore = new IndexStore(logger, databasePath);
    }

    // The SQL door's per-type views, created on the first filter rather than at Initialize (ADR-0011).
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

        var containers = new ContainerDocuments(release, _schemas);
        _pluginIngest = new PluginIngest(Connection, _logger, containers);
        _workingTreeOverlay = new WorkingTreeOverlay(Connection, _logger, _codec, containers, _schemas);
        _sourceValidation = new SourceValidation(this, Connection, _logger);

        // Unindex is this class's cross-cutting verb (registration plus every ingest-owned table), so
        // acting on the stale set stays here.
        foreach (var key in _indexStore.ValidateAgainstDisk())
            Unindex(key);
    }

    // ADR-0014: the rebuild endpoint's whole job on an already-opened index — construction already
    // refused (IndexHeldElsewhereException) if another process held the file, so nothing here
    // re-checks that. atLeastSequence keeps Sequence monotonic within this process across the drop.
    internal void RebuildEmpty(GameRelease release, long atLeastSequence)
    {
        _indexStore.RebuildFile();
        Initialize(release);
        _indexStore.SeedSequence(atLeastSequence);
    }

    // --- Indexing ---

    public void Index(IPluginDocuments documents, Registration registration, PluginCopyKey key, string? filePath = null) =>
        Index(documents, registration, key.Name, key.Origin, filePath);

    /// <summary>See <see cref="IRecordIndex.IndexedContentHash"/>.</summary>
    public string? IndexedContentHash(PluginCopyKey key) => _indexStore.IndexedContentHash(key);

    /// <summary>See <see cref="IRecordIndex.Sequence"/>.</summary>
    public long Sequence => _indexStore.CurrentSequence();

    /// <summary>See <see cref="IRecordIndex.BeginProjection"/>.</summary>
    public IDisposable BeginProjection() => _indexStore.BeginProjection();

    /// <summary>See <see cref="IRecordIndex.Announce"/>.</summary>
    public void Announce(Action publish) => _indexStore.Announce(publish);

    // ADR-0012: origin is threaded into every per-plugin delete/upsert/append so a plugin is
    // identified by (origin, plugin) together, never filename alone.
    private void Index(
        IPluginDocuments documents, Registration registration, string plugin, string origin, string? filePath)
    {
        var schemas = RequireSchemas();

        // One transaction for the whole reindex so a throw partway leaves the read model intact
        // rather than a partial snapshot. DuckDB appenders enroll in the active transaction, so
        // deletes and appender flushes roll back together on Dispose-without-Commit.
        using var tx = Connection.BeginTransaction();

        // One `registrations` row per indexed plugin, in the same transaction as its rows: ADR-0009
        // makes registration visibility, so rows arriving without it would answer nothing.
        UpsertRegistration(plugin, origin, registration);
        // And the disk claim these rows are about, replaced with them rather than beside them.
        _indexStore.StampIndexedFile(plugin, origin, filePath);

        // Must run before the appender is created.
        _pluginIngest.DeletePriorDocuments(plugin, origin);

        // The appender's `using` stays here so its disposal keeps the required ordering relative to
        // tx.Commit() below: tx declared first, appender second, both disposed LIFO after the commit.
        using var documentAppender = Connection.CreateAppender("mirror", "records");
        var timing = _pluginIngest.IndexPlugin(documents, plugin, origin, schemas, documentAppender);
        _indexStore.BumpSequence();

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

    public void Unindex(PluginCopyKey key) => Unindex(key.Name, key.Origin);

    // The `registrations` row is dropped last: while it exists this (origin, plugin) is still a
    // known member of the read model, so no read can meet rows that have already gone.
    private void Unindex(string plugin, string origin)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Unindexing {Plugin} from {Origin}", plugin, origin);
        }
        using var tx = Connection.BeginTransaction();

        _pluginIngest.DeleteAllRowsFor(plugin, origin);
        // The file claim goes with the rows it describes — Unindex is the file-gone verb, so leaving
        // it behind would leave the files table asserting rows the index does not hold.
        _indexStore.DeleteIndexedFile(plugin, origin);
        DeleteRegistration(plugin, origin);
        _indexStore.BumpSequence();

        tx.Commit();
    }

    // ADR-0013: one row per registered copy. ADR-0013: participation is derived from the three facts
    // here by Registration.Participates, never a column.
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

    // ADR-0009: registration is visibility. Every public relation is a view over its `mirror.` table
    // joined to this row, so writing or deleting the row makes a plugin's rows answer or fall
    // silent; neither verb touches a data row.
    public void Register(PluginCopyKey key, Registration registration)
    {
        using var tx = Connection.BeginTransaction();
        UpsertRegistration(key.Name, key.Origin, registration);
        _indexStore.BumpSequence();
        tx.Commit();
    }

    public void Unregister(PluginCopyKey key)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Unregistering {Plugin} from {Origin}", key.Name, key.Origin);
        }
        using var tx = Connection.BeginTransaction();
        DeleteRegistration(key.Name, key.Origin);
        _indexStore.BumpSequence();
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.RegisteredPlugins"/>.</summary>
    public IReadOnlyList<PluginCopyKey> RegisteredPlugins()
    {
        var keys = new List<PluginCopyKey>();
        using var connection = OpenRead();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT plugin, origin FROM {TableDdlBuilder.RegistrationsRelation}";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            keys.Add(new PluginCopyKey(reader.GetString(0), reader.GetString(1)));
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
    public void UpdateWinners(IReadOnlyList<RegisteredCopy> participating)
    {
        using var tx = Connection.BeginTransaction();
        ReplaceParticipating(participating);
        UpdateWinnersCore();
        _indexStore.BumpSequence();
        tx.Commit();
    }

    // The same sweep for a projection that moved rows without moving the load order: who
    // participates cannot change here, so the set the last sweep was handed still holds.
    private void ResweepWinners()
    {
        using var tx = Connection.BeginTransaction();
        UpdateWinnersCore();
        _indexStore.BumpSequence();
        tx.Commit();
    }

    // ADR-0013: replaced whole, never diffed. The rule that decided membership ran in the load order
    // value (Registration.Participates); nothing here re-asks it.
    private void ReplaceParticipating(IReadOnlyList<RegisteredCopy> participating)
    {
        Execute($"DELETE FROM {TableDdlBuilder.ParticipatingRelation}");
        foreach (var copy in participating)
        {
            using var cmd = Connection.CreateCommand();
            cmd.CommandText = $"INSERT INTO {TableDdlBuilder.ParticipatingRelation} (plugin, origin, load_order_idx) VALUES ($1, $2, $3)";
            cmd.Parameters.Add(new DuckDBParameter { Value = copy.Name });
            cmd.Parameters.Add(new DuckDBParameter { Value = copy.Origin });
            cmd.Parameters.Add(new DuckDBParameter { Value = copy.Slot!.Value });
            cmd.ExecuteNonQuery();
        }
    }

    // The sweep itself, unwrapped: a caller already inside a transaction (the projection verbs
    // below) calls this directly, since DuckDB refuses a second BeginTransaction on one connection.
    private void UpdateWinnersCore()
    {
        Execute($"DELETE FROM {TableDdlBuilder.WinnersRelation}");

        // Effective, one relation: the header is an ordinary `records` row, swept here by
        // construction. form_lookup gets no branch: ADR-0005 keeps one lookup row per Effective
        // record row, so `records`' winners are form_lookup's.
        InsertWinners(RecordRef.Effective, "SELECT form_key, plugin, origin FROM mirror.records");

        // Head, over the same membership relation records_head itself is built on. A record the
        // working tree deleted is gone from Effective but still held at Head, so the two stacks can
        // name different winners for one FormKey.
        InsertWinners(RecordRef.Head, $"SELECT form_key, plugin, origin FROM {TableDdlBuilder.HeadRowsRelation}");
    }

    // The participating plugin latest in the load order wins its FormKey. The join is
    // `participating` alone, so no SQL re-spells who competes; QUALIFY and the (plugin, origin)
    // tiebreak make a load_order_idx tie deterministic.
    private void InsertWinners(RecordRef @ref, string rowsSql) =>
        Execute($"""
            INSERT INTO {TableDdlBuilder.WinnersRelation} (record_ref, form_key, plugin, origin)
            SELECT '{WinnerRef.Of(@ref)}', r.form_key, r.plugin, r.origin
            FROM ({rowsSql}) r
            JOIN {TableDdlBuilder.ParticipatingRelation} p
              ON p.plugin = r.plugin AND p.origin = r.origin
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY r.form_key
                ORDER BY p.load_order_idx DESC, r.plugin, r.origin) = 1
            """);

    // --- Working-tree changes ---

    /// <summary>The projector's landing of re-derived documents: one transaction for the batch, so a
    /// throw partway cannot leave Effective and Head disagreeing. A null body is the document
    /// gone.</summary>
    internal void ProjectDocuments(PluginCopyKey key, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        if (deltas.Count == 0) return;

        List<string> touched;
        using (var tx = Connection.BeginTransaction())
        {
            // Only a delta that added or removed a row can move winner status. Re-swept for the whole
            // load order rather than per FormKey because UpdateWinners is the one definition of winning
            // (measured at 18 ms over 48k records).
            var projected = _workingTreeOverlay.ProjectDocuments(key, deltas);
            if (projected.Structural) UpdateWinnersCore();
            touched = projected.Touched;
            _indexStore.BumpSequence();
            tx.Commit();
        }

        // ADR-0014: after the commit, so a subscriber re-reading on receipt sees the rows this
        // names — embedded children included, since a record panel open on a placed ref inside a
        // refreshed cell has no other signal.
        _indexStore.Announce(() => _notifications?.Publish(new RowsChangedNotification(key, touched, Sequence)));
    }

    /// <summary>See <see cref="IRecordIndex.SetCommittedBaseline"/>.</summary>
    public void SetCommittedBaseline(PluginCopyKey key, IReadOnlyList<(string FormKey, string Body)> baselines)
    {
        if (baselines.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        _workingTreeOverlay.SetCommittedBaseline(key, baselines);
        _indexStore.BumpSequence();
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.MarkWorkingTreeOnly"/>.</summary>
    public void MarkWorkingTreeOnly(PluginCopyKey key, IReadOnlyList<string> formKeys)
    {
        if (formKeys.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        _workingTreeOverlay.MarkWorkingTreeOnly(key, formKeys);
        // Effective is untouched, but Head just lost a row per FormKey, which can promote the next
        // plugin down at that ref; Head's winners are swept, not derived per read (ADR-0009).
        UpdateWinnersCore();
        _indexStore.BumpSequence();
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.SeedCommittedOnly"/>. One transaction for the whole batch:
    /// the three head-state writes are all-or-nothing together, so a throw partway through a
    /// reconciliation pass cannot leave half of one applied.</summary>
    public void SeedCommittedOnly(PluginCopyKey key, IReadOnlyList<(string FormKey, string RecordType, string Body)> records)
    {
        if (records.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        _workingTreeOverlay.SeedCommittedOnly(key, records);
        // The counterpart of MarkWorkingTreeOnly's sweep: Head just gained a row per FormKey, which can
        // demote whoever was winning it at that ref. Effective is untouched either way.
        UpdateWinnersCore();
        _indexStore.BumpSequence();
        tx.Commit();
    }

    // --- Refresh ---

    /// <summary>See <see cref="IRecordIndex.RefreshByKeys"/>.</summary>
    public void RefreshByKeys(PluginCopyKey key, string modFolder, IReadOnlyList<string> formKeys)
    {
        // One signal, one advance, however many documents and refs it moves.
        using var projection = BeginProjection();

        // A key at neither ref is a record the tree has gained, and no document says where the tree
        // puts it: a new exterior cell's block is a directory, not a field.
        if (formKeys.Any(formKey => At(RecordRef.Effective).GetDocument(formKey, key) == null
                                    && At(RecordRef.Head).GetDocument(formKey, key) == null))
        {
            RederiveWholeCopyFromSource(key, modFolder);
            return;
        }

        // One repository for the batch, so its listing memo and embedded-owner map are built once
        // rather than once per key.
        var repository = SourceRepository.Over(modFolder, _release);
        foreach (var formKey in formKeys)
            RefreshOneKey(repository, key, formKey);
    }

    // Re-derives one key's rows at both refs. Called again with the same bytes, nothing below fires.
    private void RefreshOneKey(SourceRepository repository, PluginCopyKey key, string formKey)
    {
        var effective = At(RecordRef.Effective).GetDocument(formKey, key);
        var head = At(RecordRef.Head).GetDocument(formKey, key);
        // Gone from both refs since the batch was read: another key's projection in this same batch
        // took it (a container's document carries its children's rows).
        var recordType = effective?.RecordType ?? head?.RecordType;
        if (recordType == null) return;

        var identity = new RecordIdentity(formKey, recordType, effective?.EditorId ?? head?.EditorId);
        var workingTreeText = repository.Get(key, identity)?.Body;

        // Never exclusive owners of the file: it can be caught mid-save, or hand-edited into
        // something that is not a document. Rows stay as they stand until it reads as one again.
        if (workingTreeText != null && !IsDocument(workingTreeText))
        {
            _logger.LogWarning(
                "{Plugin} ({Origin})'s source for {FormKey} is not a readable document, so its rows were left as " +
                "they stand", key.Name, key.Origin, formKey);
            return;
        }

        if (!string.Equals(workingTreeText, effective?.Body, StringComparison.Ordinal))
            ProjectDocuments(key, [(formKey, workingTreeText)]);

        // Re-read, since the projection above may have moved this record's committed row too. Asked
        // only for a record the index already believes dirty.
        if (At(RecordRef.Head).GetDocument(formKey, key)?.Body is { } committedBody
            && repository.CommittedTextIfMoved(key, identity, committedBody) is { } movedText)
        {
            SetCommittedBaseline(key, [(formKey, movedText)]);
        }
    }

    private static bool IsDocument(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    // The whole tree, read as one mod: where a record sits is a fact about the tree, not about one
    // document. Idempotent by construction, being the ingest Track and a re-index run.
    private void RederiveWholeCopyFromSource(PluginCopyKey key, string modFolder)
    {
        // Nothing to re-derive from: the tree went away between the signal and this line, or this
        // copy's rows came from its binary and a source key is not its to answer for.
        if (!SourceRepository.HoldsTreeFor(modFolder, key.Name)) return;
        if (RegistrationOf(key) is not { } registration) return;

        // Ingest, head reconcile and winner sweep are one whole-plugin projection, so they are one
        // advance and the notification below carries the number a subscriber can await.
        using (BeginProjection())
        {
            SourceIngest.Ingest(
                this, modFolder, registration, key, _indexStore.IndexedFile(key)?.FilePath,
                _release, _schemaReflector, _logger);
            ResweepWinners();
        }

        // ADR-0014: too many rows to name, exactly as the plugin watcher's own re-index reports it.
        _indexStore.Announce(() => _notifications?.Publish(new PluginChangedNotification(key, Sequence)));
    }

    // The three facts the copy's registration row carries (ADR-0013), read back for a re-ingest that
    // must not change what the load order said about this copy.
    private Registration? RegistrationOf(PluginCopyKey key)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText =
            $"SELECT load_order_idx, enabled, winning FROM {TableDdlBuilder.RegistrationsRelation} " +
            "WHERE plugin = $1 AND origin = $2";
        DuckDbSql.AddParams(cmd, [key.Name, key.Origin]);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;
        return new Registration(
            reader.IsDBNull(0) ? null : reader.GetInt32(0), reader.GetBoolean(1), reader.GetBoolean(2));
    }

    // --- Validate ---

    /// <summary>See <see cref="IRecordIndex.Validate"/>.</summary>
    public ValidationReport Validate(PluginCopyKey key, string? modFolder)
    {
        if (modFolder != null && SourceRepository.IsTracked(modFolder))
            return _sourceValidation.Validate(key, modFolder);

        return ValidateAgainstBinary(key);
    }

    // Validate's own publish. MarkWorkingTreeOnly does not publish for itself: ingest calls it for
    // every reconciled record of a whole plugin, where a notification per record would be noise.
    internal void PublishRowsChanged(PluginCopyKey key, IReadOnlyList<string> formKeys) =>
        _indexStore.Announce(() => _notifications?.Publish(new RowsChangedNotification(key, formKeys, Sequence)));

    // ADR-0009's load-time check, asked of one copy: the stored hash against the bytes on disk. A
    // binary has no smaller unit, so a mismatch is a rebuild the caller owns.
    private ValidationReport ValidateAgainstBinary(PluginCopyKey key)
    {
        // Nothing vouches for these rows (an in-memory mod, or a tracked copy whose folder went
        // away), so there is nothing to compare them against.
        if (_indexStore.IndexedFile(key) is not { } claim) return ValidationReport.Clean(key);

        if (!File.Exists(claim.FilePath))
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "{Plugin} ({Origin}) is absent from disk at {Path}; removing its rows",
                    key.Name, key.Origin, claim.FilePath);
            }
            Unindex(key);
            return ValidationReport.Clean(key);
        }

        // A file that cannot be read is no evidence its rows are still true, so it counts as a
        // mismatch — IndexStore.ValidateAgainstDisk's own rule.
        return PluginBinaryHash.OfFile(claim.FilePath) == claim.ContentHash
            ? ValidationReport.Clean(key)
            : new ValidationReport(key, [], NeedsRebuild: true, []);
    }

    // --- Queries ---

    // `records` holds one row per record copy and that row is Effective, so every read reaches its
    // ref by naming a relation of the same shape; no read carries a ref predicate.
    private const string EffectiveRelation = "records";
    private const string HeadRelation = "records_head";

    private IRecordReads? _effectiveReads;
    private IRecordReads? _headReads;

    // Empty until the projector points it somewhere: a store opened by a test that never reconciles
    // has no copies open, which is what an empty set says.
    private Func<IReadOnlyDictionary<PluginCopyKey, PluginContent>> _openedCopies =
        () => new Dictionary<PluginCopyKey, PluginContent>();

    public void ReadOpenedCopiesFrom(Func<IReadOnlyDictionary<PluginCopyKey, PluginContent>> opened) =>
        _openedCopies = opened;

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
        public IReadOnlyDictionary<PluginCopyKey, PluginContent> OpenedCopies => owner._openedCopies();

        public RecordDocument? GetDocument(string formKey)
        {
            using var connection = owner.OpenRead();
            owner.RequireSchemas(); // fails before any query runs, though OpenRead above has already opened the connection
            var tableName = FindRecordType(connection, records, formKey);
            return tableName == null ? null : owner.ReadDocument(connection, records, tableName, formKey, plugin: null, origin: null, winnerOnly: true);
        }

        public RecordDocument? GetDocument(string formKey, PluginCopyKey plugin)
        {
            using var connection = owner.OpenRead();
            owner.RequireSchemas();
            var tableName = FindRecordType(connection, records, formKey);
            return tableName == null ? null : owner.ReadDocument(connection, records, tableName, formKey, plugin.Name, plugin.Origin, winnerOnly: false);
        }

        // One query rather than two point queries per record. Rows are materialized before
        // reconstitution: resolving a FormKey opens its own command on this connection, which would
        // interleave two readers.
        public IReadOnlyList<RecordDocument> GetDocuments(PluginCopyKey plugin)
        {
            using var connection = owner.OpenRead();
            var schemas = owner.RequireSchemas();
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, record_type, parse_diagnosis
                FROM {records}
                WHERE plugin = $1 AND origin = $2
                """;
            AddParams(cmd, [plugin.Name, plugin.Origin]);
            using var reader = cmd.ExecuteReader();

            var rows = new List<(string FormKey, string Plugin, string Origin, int LoadOrderIndex,
                bool IsWinner, string? EditorId, string Body, string RecordType, string? ParseDiagnosis)>();
            while (reader.Read())
            {
                rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2),
                    LoadOrderSortKey(reader, 3), reader.GetBoolean(4),
                    reader.IsDBNull(5) ? null : reader.GetString(5),
                    reader.GetString(6), reader.GetString(7), reader.IsDBNull(8) ? null : reader.GetString(8)));
            }
            reader.Close();

            // One resolution cache for the whole batch: the same referenced FormKey recurs across a
            // plugin's records, and every miss is a form_lookup query. Resolution is a pure lookup, so
            // sharing changes nothing.
            var resolve = FormKeyResolutionCache.Memoize(formKey => ResolveFormKey(connection, formKey));

            var documents = new List<RecordDocument>(rows.Count);
            foreach (var row in rows)
            {
                // Same defensive skip as RederiveIndexRowsForRecord: a record_type no schema claims
                // has no reconstitution path.
                if (!schemas.TryGetValue(row.RecordType, out var schema)) continue;
                documents.Add(owner.DocumentFromBody(
                    row.FormKey, row.Plugin, row.Origin, row.LoadOrderIndex, row.IsWinner,
                    row.EditorId, row.Body, schema, resolve, row.ParseDiagnosis));
            }
            return documents;
        }

        public RecordOverrides? GetOverrideStack(string formKey)
        {
            using var connection = owner.OpenRead();
            owner.RequireSchemas(); // fails before any query runs, though OpenRead above has already opened the connection
            var tableName = FindRecordType(connection, records, formKey);
            if (tableName == null) return null;
            var schema = owner.RequireSchemas()[tableName];
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, parse_diagnosis, "ref"
                FROM {records}
                WHERE form_key = $1 AND record_type = $2
                ORDER BY load_order_idx
                """;
            cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
            cmd.Parameters.Add(new DuckDBParameter { Value = NormalizeRecordType(tableName) });
            using var reader = cmd.ExecuteReader();

            var resolve = FormKeyResolutionCache.Memoize(formKey => ResolveFormKey(connection, formKey));

            // Read the whole stack out before resolving any Head counterpart — ReadDocument opens
            // its own command on this same connection, and doing that while this reader is still open
            // would interleave two readers on one DuckDB connection.
            var rows = new List<(RecordDocument Document, bool IsDirty)>();
            while (reader.Read())
            {
                var doc = owner.ReadDocumentFromBody(reader, schema, resolve);
                // On a Head-scoped read every row is committed by construction, so this reads false
                // for all of them without needing to know which relation it is on.
                var isDirty = reader.GetString(8) == SourceRef.WorkingTree;
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
                    ? owner.ReadDocument(connection, HeadRelation, tableName, doc.FormKey, doc.Plugin.Name, doc.Plugin.Origin, winnerOnly: false) ?? doc
                    : doc;
                entries.Add(new OverrideStackEntry(doc.Plugin, doc.LoadOrderIndex, doc.IsWinner, doc, head, isDirty));
            }

            return entries.Count == 0 ? null : new RecordOverrides(formKey, tableName, entries);
        }

        public PagedResult<RecordSummary> Search(RecordQuery query)
        {
            using var connection = owner.OpenRead();
            var (where, paramValues) = BuildWhere(
                query.Plugin?.Name, query.Search, owner._filterActive, query.Origin, query.RecordTypes);
            // Modified is ref='working-tree' with a committed snapshot; Added is the same ref with no
            // snapshot (a create writes nothing into records_committed). has_container_children is the
            // same correlated-EXISTS shape against container_child, which is never duplicated per ref.
            var cols = $"""
                form_key, plugin, load_order_idx, is_winner, editor_id, origin, r."ref",
                EXISTS (
                    SELECT 1 FROM records_committed rc
                    WHERE rc.form_key = r.form_key AND rc.plugin = r.plugin AND rc.origin = r.origin
                ) AS has_committed_snapshot,
                EXISTS (
                    SELECT 1 FROM container_child cc
                    WHERE cc.parent_form_key = r.form_key AND cc.plugin = r.plugin AND cc.origin = r.origin
                ) AS has_container_children,
                r.parse_diagnosis,
                r.parse_diagnosis IS NOT NULL OR EXISTS (
                    SELECT 1 FROM container_child cc
                    JOIN {records} cr ON cr.form_key = cc.child_form_key AND cr.plugin = cc.plugin AND cr.origin = cc.origin
                    WHERE cc.parent_form_key = r.form_key AND cc.plugin = r.plugin AND cc.origin = r.origin
                      AND cr.parse_diagnosis IS NOT NULL
                ) AS has_parse_failure
                """;

            using var countCmd = connection.CreateCommand();
            countCmd.CommandText = $"SELECT COUNT(*) FROM {records}{where}";
            AddParams(countCmd, paramValues);
            var total = (long)countCmd.ExecuteScalar()!;

            // editor_id alone is not unique — blank and duplicate EditorIDs are ordinary — so
            // LIMIT/OFFSET over it alone lets DuckDB place tied rows on either side of a page boundary
            // differently across calls. (form_key, plugin, origin) makes the order total.
            using var dataCmd = connection.CreateCommand();
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
        public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginCopyKey plugin)
        {
            using var connection = owner.OpenRead();
            var (where, paramValues) = BuildWhere(plugin.Name, null, owner._filterActive, plugin.Origin, recordTypes: null);
            using var cmd = connection.CreateCommand();
            cmd.CommandText =
                $"SELECT record_type, COUNT(*), BOOL_OR(parse_diagnosis IS NOT NULL) FROM {records}{where} GROUP BY record_type";
            AddParams(cmd, paramValues);
            var counts = new List<RecordTypeCount>();
            using (var reader = cmd.ExecuteReader())
            {
                while (reader.Read())
                    counts.Add(new RecordTypeCount(reader.GetString(0), (int)reader.GetInt64(1), reader.GetBoolean(2)));
            }

            // Merged in C# rather than joined: a type whose enumeration failed can have no rows
            // at all, so it is absent from the GROUP BY above and would vanish from the tree.
            var failedTypes = FailedRecordTypes(connection, plugin);
            for (var i = 0; i < counts.Count; i++)
            {
                if (failedTypes.Contains(counts[i].Type)) counts[i] = counts[i] with { HasParseFailure = true };
            }
            counts.AddRange(failedTypes
                .Where(t => !counts.Exists(c => string.Equals(c.Type, t, StringComparison.OrdinalIgnoreCase)))
                .Select(t => new RecordTypeCount(t, 0, HasParseFailure: true)));
            return counts;
        }

        // Unfiltered: a record filter narrows what is listed, never whether a type could be read.
        private static HashSet<string> FailedRecordTypes(DuckDBConnection connection, PluginCopyKey plugin)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText =
                "SELECT DISTINCT record_type FROM record_type_failure WHERE plugin = $1 AND origin = $2";
            AddParams(cmd, [plugin.Name, plugin.Origin]);
            using var reader = cmd.ExecuteReader();

            var types = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (reader.Read()) types.Add(reader.GetString(0));
            return types;
        }

        public RecordLookupEntry? Resolve(string formKey)
        {
            using var connection = owner.OpenRead();
            return ResolveFormKey(connection, formKey);
        }

        public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey)
        {
            using var connection = owner.OpenRead();
            return GetReferences(connection, targetFormKey);
        }

        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames)
        {
            var types = tableNames.ToList();
            if (types.Count == 0 || !owner._filterActive)
                return new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            using var connection = owner.OpenRead();

            var (where, paramValues) = BuildWhere(null, null, filterActive: true, origin: null, recordTypes: types);

            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"SELECT DISTINCT plugin FROM {records}{where}";
            AddParams(cmd, paramValues);
            using var reader = cmd.ExecuteReader();

            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (reader.Read())
                result.Add(reader.GetString(0));
            return result;
        }

        /// <summary>Both halves of "could not be read": a record whose own document failed, and a
        /// record type whose enumeration did. Keyed by <c>ColumnKey.Of</c> rather than a bare
        /// filename, which two loaded copies can share.</summary>
        public IReadOnlySet<string> GetPluginsWithParseFailures()
        {
            using var connection = owner.OpenRead();
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT DISTINCT plugin, origin FROM {records} WHERE parse_diagnosis IS NOT NULL
                UNION
                SELECT DISTINCT plugin, origin FROM record_type_failure
                """;
            using var reader = cmd.ExecuteReader();

            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (reader.Read())
                result.Add(ColumnKey.Of(reader.GetString(0), reader.GetString(1)));
            return result;
        }

        public IReadOnlySet<string> GetWorldspacesWithFailuresBelow(PluginCopyKey plugin)
        {
            using var connection = owner.OpenRead();
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT DISTINCT cl.parent_worldspace
                FROM cell_location cl
                LEFT JOIN {records} c
                  ON c.form_key = cl.cell_form_key AND c.plugin = cl.plugin AND c.origin = cl.origin
                WHERE cl.parent_worldspace IS NOT NULL AND cl.plugin = $1 AND cl.origin = $2
                  AND (c.parse_diagnosis IS NOT NULL OR EXISTS (
                    SELECT 1 FROM placement p
                    JOIN {records} pr ON pr.form_key = p.form_key AND pr.plugin = p.plugin AND pr.origin = p.origin
                    WHERE p.parent_cell = cl.cell_form_key AND p.plugin = cl.plugin AND p.origin = cl.origin
                      AND pr.parse_diagnosis IS NOT NULL))
                """;
            AddParams(cmd, [plugin.Name, plugin.Origin]);
            using var reader = cmd.ExecuteReader();

            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (reader.Read()) result.Add(reader.GetString(0));
            return result;
        }

        public IReadOnlyList<string> GetNativeFormKeys(PluginCopyKey plugin)
        {
            using var connection = owner.OpenRead();
            // The header is excluded explicitly: its synthetic 000000:<plugin> FormKey names no record,
            // and the caller that computes the next free local FormID would be handed a FormKey no
            // record occupies.
            using var cmd = connection.CreateCommand();
            cmd.CommandText =
                $"SELECT DISTINCT form_key FROM {records} WHERE plugin = $1 AND origin = $2 AND record_type <> '{PluginHeader.RecordType}'";
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Name });
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Origin });
            using var reader = cmd.ExecuteReader();

            var result = new List<string>();
            while (reader.Read())
            {
                var fk = reader.GetString(0);
                var colon = fk.IndexOf(':');
                if (colon > 0 && fk.AsSpan(colon + 1).Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
                    result.Add(fk);
            }
            return result;
        }

        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginCopyKey plugin, string worldspaceFormKey)
        {
            using var connection = owner.OpenRead();
            using var cmd = connection.CreateCommand();
            // full_name is read from the joined row's JSON. '$.Name.Value' is what the codec emits for
            // an unlocalized plugin's FULL; a localized plugin serializes '$.Name.Values' instead, which
            // this misses, falling back to the grid/EditorID label.
            cmd.CommandText = $"""
                SELECT cl.cell_form_key, c.editor_id, cl.block_x, cl.block_y, cl.sub_x, cl.sub_y, cl.grid_x, cl.grid_y,
                       json_extract_string(c.body, '$.Name.Value'),
                       c.parse_diagnosis IS NOT NULL OR EXISTS (
                           SELECT 1 FROM placement p
                           JOIN {records} pr ON pr.form_key = p.form_key AND pr.plugin = p.plugin AND pr.origin = p.origin
                           WHERE p.parent_cell = cl.cell_form_key AND p.plugin = cl.plugin AND p.origin = cl.origin
                             AND pr.parse_diagnosis IS NOT NULL
                       )
                FROM cell_location cl
                LEFT JOIN {records} c ON c.form_key = cl.cell_form_key AND c.plugin = cl.plugin AND c.origin = cl.origin
                WHERE cl.parent_worldspace = $1 AND cl.plugin = $2 AND cl.origin = $3
                ORDER BY cl.block_x, cl.block_y, cl.sub_x, cl.sub_y, cl.grid_x, cl.grid_y
                """;
            AddParams(cmd, [worldspaceFormKey, plugin.Name, plugin.Origin]);
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
                    reader.IsDBNull(8) ? null : reader.GetString(8),
                    reader.GetBoolean(9)));
            }

            return rows;
        }

        public PagedResult<CellSummary> GetInteriorCells(PluginCopyKey plugin, int limit, int offset)
        {
            using var connection = owner.OpenRead();
            using var countCmd = connection.CreateCommand();
            countCmd.CommandText = "SELECT COUNT(*) FROM cell_location WHERE is_interior AND plugin = $1 AND origin = $2";
            countCmd.Parameters.Add(new DuckDBParameter { Value = plugin.Name });
            countCmd.Parameters.Add(new DuckDBParameter { Value = plugin.Origin });
            var total = (long)countCmd.ExecuteScalar()!;

            // Same non-unique-ordering shape as Search: c.editor_id alone gives no tiebreak for
            // LIMIT/OFFSET. The WHERE already scopes to one plugin+origin, so cl.cell_form_key alone is
            // a sufficient tiebreak.
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT cl.cell_form_key, c.editor_id, cl.grid_x, cl.grid_y,
                       c.parse_diagnosis IS NOT NULL OR EXISTS (
                           SELECT 1 FROM placement p
                           JOIN {records} pr ON pr.form_key = p.form_key AND pr.plugin = p.plugin AND pr.origin = p.origin
                           WHERE p.parent_cell = cl.cell_form_key AND p.plugin = cl.plugin AND p.origin = cl.origin
                             AND pr.parse_diagnosis IS NOT NULL
                       )
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
                    reader.IsDBNull(3) ? null : reader.GetInt32(3),
                    HasParseFailure: reader.GetBoolean(4)));
            }

            return new PagedResult<CellSummary>(items, (int)total);
        }

        public CellReferences GetCellReferences(PluginCopyKey plugin, string cellFormKey)
        {
            var schemas = owner.RequireSchemas();
            var placedTypes = PlacedTableNames.Where(schemas.ContainsKey).ToList();
            if (placedTypes.Count == 0)
                return new CellReferences([], []);

            using var connection = owner.OpenRead();

            // ADR-0007: the placed ref's base form comes out of the document rather than a `base`
            // column; json_extract_string unquotes the stored FormLink text, and a placed ref with no
            // base reads NULL.
            var typeList = string.Join(", ", placedTypes.Select(t => $"'{t}'"));

            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT p.placement_group, r.record_type, p.form_key, r.editor_id,
                       json_extract_string(r.body, '$.Base'), r.parse_diagnosis IS NOT NULL
                FROM placement p
                JOIN {records} r ON r.form_key = p.form_key AND r.plugin = p.plugin AND r.origin = p.origin
                WHERE p.parent_cell = $1 AND p.plugin = $2 AND p.origin = $3
                  AND r.record_type IN ({typeList})
                ORDER BY r.editor_id
                """;
            AddParams(cmd, [cellFormKey, plugin.Name, plugin.Origin]);
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
                    reader.GetString(1),
                    reader.GetBoolean(5));
                (group == "persistent" ? persistent : temporary).Add(summary);
            }
            return new CellReferences(persistent, temporary);
        }

        public PlacementRow? GetPlacement(string formKey, PluginCopyKey plugin)
        {
            using var connection = owner.OpenRead();
            return GetPlacement(connection, formKey, plugin.Name, plugin.Origin);
        }

        public CellLocationRow? GetCellLocation(PluginCopyKey plugin, string cellFormKey)
        {
            using var connection = owner.OpenRead();
            return GetCellLocation(connection, cellFormKey, plugin.Name, plugin.Origin);
        }

        public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginCopyKey plugin, string parentFormKey)
        {
            using var connection = owner.OpenRead();
            return GetContainerChildren(connection, plugin.Name, plugin.Origin, parentFormKey);
        }

        public ContainerChildRow? GetContainerParent(PluginCopyKey plugin, string childFormKey)
        {
            using var connection = owner.OpenRead();
            return GetContainerParent(connection, plugin.Name, plugin.Origin, childFormKey);
        }

        // Column 6 is "ref", column 7 the correlated records_committed EXISTS Search's SELECT adds.
        // Decided in C# rather than as SQL string literals the reader would parse.
        private static WorkingTreeState ReadWorkingTreeState(DuckDBDataReader reader)
        {
            if (reader.GetString(6) != SourceRef.WorkingTree) return WorkingTreeState.None;
            return reader.GetBoolean(7) ? WorkingTreeState.Modified : WorkingTreeState.Added;
        }

        // Column 8 is the correlated container_child EXISTS Search's SELECT adds, 9 this record's
        // own diagnosis and 10 the same fact widened to its children, read positionally like 6/7.
        private static RecordSummary ReadSummary(DuckDBDataReader reader) =>
            new(reader.GetString(0), reader.GetString(1), LoadOrderSortKey(reader, 2),
                reader.GetBoolean(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetString(5),
                ReadWorkingTreeState(reader), reader.GetBoolean(8),
                reader.IsDBNull(9) ? null : reader.GetString(9), reader.GetBoolean(10));

        // origin (ADR-0012): nullable and independent of plugin — a *filter*, not an identity field.
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

        // Private: table-name dispatch is rejected from the seam; GetDocument and GetOverrideStack
        // resolve a FormKey's type themselves rather than being told it.
        private static string? FindRecordType(DuckDBConnection connection, string records, string formKey)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"SELECT record_type FROM {records} WHERE form_key = $1 LIMIT 1";
            cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
            return cmd.ExecuteScalar() as string;
        }

        private static List<ReferenceResult> GetReferences(DuckDBConnection connection, string targetFormKey)
        {
            // ADR-0007: WorkingTreeOverlay keeps form_references rewritten as the working tree
            // changes, so this already sees every edit without applying anything itself.
            const string sql = """
                SELECT fr.source_form_key, fr.source_plugin, fr.field_path, fr.record_type, fr.editor_id, fr.source_origin
                FROM form_references fr
                WHERE fr.target_form_key = $1
                """;

            using var cmd = connection.CreateCommand();
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

        // ── Worldspace tree reads (ADR-0005) ────────────────────────────────────────

        private static PlacementRow? GetPlacement(DuckDBConnection connection, string formKey, string plugin, string origin)
        {
            using var cmd = connection.CreateCommand();
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

        private static CellLocationRow? GetCellLocation(DuckDBConnection connection, string cellFormKey, string plugin, string origin)
        {
            using var cmd = connection.CreateCommand();
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

        private static List<ContainerChildRow> GetContainerChildren(DuckDBConnection connection, string plugin, string origin, string parentFormKey)
        {
            using var cmd = connection.CreateCommand();
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
        private static ContainerChildRow? GetContainerParent(DuckDBConnection connection, string plugin, string origin, string childFormKey)
        {
            using var cmd = connection.CreateCommand();
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
    }

    private RecordDocument? ReadDocument(DuckDBConnection connection, string records, string tableName, string formKey, string? plugin, string? origin, bool winnerOnly)
    {
        var schema = RequireSchemas()[tableName];
        var conditions = new List<string> { "form_key = $1" };
        var values = new List<string> { formKey };

        if (winnerOnly) conditions.Add("is_winner = true");
        if (plugin != null) { conditions.Add($"plugin = ${values.Count + 1}"); values.Add(plugin); }
        if (origin != null) { conditions.Add($"origin = ${values.Count + 1}"); values.Add(origin); }

        conditions.Add($"record_type = ${values.Count + 1}");
        values.Add(NormalizeRecordType(tableName));

        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, parse_diagnosis
            FROM {records} WHERE {string.Join(" AND ", conditions)}
            LIMIT 1
            """;
        AddParams(cmd, values);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;

        return ReadDocumentFromBody(reader, schema, FormKeyResolutionCache.Memoize(formKey => ResolveFormKey(connection, formKey)));
    }

    private RecordDocument ReadDocumentFromBody(
        DuckDBDataReader reader, RecordTableSchema schema, Func<string, RecordLookupEntry?> resolveFormKey) =>
        DocumentFromBody(
            reader.GetString(0), reader.GetString(1), reader.GetString(2), LoadOrderSortKey(reader, 3),
            reader.GetBoolean(4), reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.GetString(6), schema, resolveFormKey, reader.IsDBNull(7) ? null : reader.GetString(7));

    // The construction half of ReadDocumentFromBody, split out so the bulk read can build documents
    // from rows materialized before reading any. The fields are the document's own nodes at each
    // column's path (ADR-0005): nothing is reconstituted.
    private RecordDocument DocumentFromBody(
        string formKey, string plugin, string origin, int loadOrderIndex, bool isWinner,
        string? editorId, string body, RecordTableSchema schema,
        Func<string, RecordLookupEntry?> resolveFormKey, string? parseDiagnosis)
    {
        using var parsed = JsonDocument.Parse(body);
        var root = parsed.RootElement;

        return new RecordDocument(
            formKey, new PluginCopyKey(plugin, origin), loadOrderIndex, isWinner, editorId, schema.TableName,
            body, BuildFields(schema, root, resolveFormKey, _release),
            // A ModHeader can neither carry the Partial Form flag nor be a type that could.
            IsPartialForm: !schema.IsHeader && PartialFormFlag.IsSet(root, schema.RecordType),
            IsPartialFormable: !schema.IsHeader && PartialFormFlag.IsPartialFormable(schema.RecordType),
            ParseDiagnosis: parseDiagnosis);
    }

    private static List<FieldValue> BuildFields(
        RecordTableSchema schema, JsonElement root,
        Func<string, RecordLookupEntry?> resolveFormKey, GameRelease release)
    {
        ResolvedFormKey? Resolve(string formKey) =>
            resolveFormKey(formKey) is { } entry ? new ResolvedFormKey(entry.RecordType, entry.EditorId) : null;

        var fields = new List<FieldValue>(schema.RecordColumns.Count);
        foreach (var col in schema.RecordColumns)
        {
            // A synthetic member is the bit it stands for, read off the member the document spells.
            var value = col.Synthetic is { } bit
                ? JsonSerializer.SerializeToElement(SyntheticBits.IsSet(root, bit))
                : DocumentNodes.At(root, col.PropertyName);
            var meta = col.ToFieldMetadata();
            // The check reads the shape this record's own class gives the column; the wire keeps the
            // column's whole metadata, variants included, so the editor can pick the same.
            fields.Add(new FieldValue(meta, value, CheckErrorBuilder.Build(DocumentNodes.VariantFor(meta, root), value, Resolve, release)));
        }
        return fields;
    }

    private static RecordLookupEntry? ResolveFormKey(DuckDBConnection connection, string formKey)
    {
        using var cmd = connection.CreateCommand();
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

    public void Dispose() => _indexStore.Dispose();
}
