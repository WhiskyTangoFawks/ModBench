using System.Data;
using System.Diagnostics;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Index;

// The single DuckDB implementation of IRecordIndex/IRecordReads, split into four collaborators:
// Store, PluginIngest, WorkingTreeOverlay and SourceValidation. This class owns every
// transaction boundary, registration, the winner sweep, reads and the SQL door.
internal sealed class DuckDbRecordIndex : IRecordIndex
{
    private readonly SchemaReflector _schemaReflector;
    private readonly ILogger _logger;
    private IReadOnlyDictionary<string, RecordTableSchema>? _schemas;
    private static readonly string[] CellChildTypeNames = ["refr", "achr", "land", "navm"];
    private bool _filterActive;

    // The records holding a filter match in the match's own plugin, so it stays reachable beneath them.
    private const string FilterHolders = "_filter_holders";
    private const string FilterMatches = "_filter";

    // ADR-0007: the per-record source codec. Constructed rather than injected: it is stateless apart
    // from static reflection caches, and every construction site would otherwise learn a dependency
    // it has no say in.
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);

    // Connection forwards to Store rather than being held here, so a rebuild that reassigns its
    // Connection is transparent to every `.Connection` reader.
    private readonly Store _store;

    // Constructed at the end of Initialize, once Connection is stable and the schemas and release
    // are resolved, so every dependency is captured once rather than chased through a mutable
    // back-reference.
    private PluginIngest? _pluginIngest;

    private PluginIngest RequirePluginIngest() =>
        _pluginIngest ?? throw new InvalidOperationException("Call Initialize before using the repository.");

    // Constructed after _pluginIngest, for the same reason and because it depends on PluginIngest
    // one-directionally.
    private WorkingTreeOverlay? _workingTreeOverlay;

    private WorkingTreeOverlay RequireWorkingTreeOverlay() =>
        _workingTreeOverlay ?? throw new InvalidOperationException("Call Initialize before using the repository.");

    // Validate's tracked half. Constructed alongside its siblings, for the same reason.
    private SourceValidation? _sourceValidation;

    public DuckDBConnection Connection => _store.Connection;
    private DuckDBConnection OpenRead() => _store.OpenReadConnection();

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
        INotificationPublisher? notifications = null,
        TimeProvider? timeProvider = null)
    {
        _schemaReflector = schemaReflector;
        _ddlBuilder = ddlBuilder;
        _logger = logger;
        _notifications = notifications;
        _store = new Store(logger, databasePath, timeProvider);
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
        // Before the schemas, not after: Store's own version check throws away a file written
        // under a different shape *before* this process starts appending to tables it only half
        // recognizes.
        _store.Initialize(indexVersion);

        _schemas = _schemaReflector.GetSchemas(release);
        _release = release;

        var containers = new ContainerDocuments(release, _schemas);
        _pluginIngest = new PluginIngest(Connection, _logger, containers);
        _workingTreeOverlay = new WorkingTreeOverlay(Connection, _logger, _codec, containers, _schemas, release);
        _sourceValidation = new SourceValidation(this, Connection, release, _logger);

        // Unindex is this class's cross-cutting verb (registration plus every ingest-owned table), so
        // acting on the stale set stays here.
        foreach (var key in _store.ValidateAgainstDisk())
            Unindex(key);
    }

    // ADR-0009 invariant 5: the rebuild's whole job on an already-opened index — construction
    // already refused (IndexHeldElsewhereException) if another process held the file, so nothing
    // here re-checks that. atLeastSequence keeps Sequence monotonic within this process.
    internal void RebuildEmpty(GameRelease release, long atLeastSequence)
    {
        _store.RebuildFile();
        Initialize(release);
        _store.SeedSequence(atLeastSequence);
    }

    // --- Indexing ---

    public void Index(IPluginDocuments documents, Registration registration, PluginAddress key, string? filePath, DerivedFrom derivedFrom) =>
        Index(documents, registration, key.Name, key.Origin, filePath, derivedFrom);

    /// <summary>See <see cref="IRecordIndex.IndexedContentHash"/>.</summary>
    public string? IndexedContentHash(PluginAddress key) => _store.IndexedContentHash(key);

    /// <summary>See <see cref="IRecordIndex.FileContentHash"/>.</summary>
    public string? FileContentHash(string path) => _store.FileContentHash(path);

    /// <summary>See <see cref="IRecordIndex.Sequence"/>.</summary>
    public long Sequence => _store.CurrentSequence();

    /// <summary>See <see cref="IRecordIndex.BeginProjection"/>.</summary>
    public IDisposable BeginProjection() => _store.BeginProjection();

    /// <summary>See <see cref="IRecordIndex.Announce"/>.</summary>
    public void Announce(Action publish) => _store.Announce(publish);

    // ADR-0012: origin is threaded into every per-plugin delete/upsert/append so a plugin is
    // identified by (origin, plugin) together, never filename alone.
    private void Index(
        IPluginDocuments documents, Registration registration, string plugin, string origin, string? filePath,
        DerivedFrom derivedFrom)
    {
        var schemas = RequireSchemas();

        // One transaction for the whole reindex so a throw partway leaves the read model intact
        // rather than a partial snapshot. DuckDB appenders enroll in the active transaction, so
        // deletes and appender flushes roll back together on Dispose-without-Commit.
        using var tx = Connection.BeginTransaction();

        // One `registrations` row per indexed plugin, in the same transaction as its rows: ADR-0009
        // makes registration visibility, so rows arriving without it would answer nothing.
        UpsertRegistration(plugin, origin, registration);
        // And the facts about these rows — the disk claim, the derivation, the diagnosis — replaced
        // with them rather than beside them.
        _store.StampPluginFacts(plugin, origin, filePath, derivedFrom);

        // Must run before the appender is created.
        RequirePluginIngest().DeletePriorDocuments(plugin, origin);

        // The appender's `using` stays here so its disposal keeps the required ordering relative to
        // tx.Commit() below: tx declared first, appender second, both disposed LIFO after the commit.
        using var documentAppender = Connection.CreateAppender("mirror", "records");
        var timing = RequirePluginIngest().IndexPlugin(documents, plugin, origin, schemas, documentAppender);
        _store.BumpSequence();

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

    public void Unindex(PluginAddress key) => Unindex(key.Name, key.Origin);

    // The `registrations` row is dropped last: while it exists this (origin, plugin) is still a
    // known member of the read model, so no read can meet rows that have already gone.
    private void Unindex(string plugin, string origin)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Unindexing {Plugin} from {Origin}", plugin, origin);
        }
        using var tx = Connection.BeginTransaction();

        RequirePluginIngest().DeleteAllRowsFor(plugin, origin);
        // The plugin's facts go with the rows they describe — Unindex is the file-gone verb, so
        // leaving them behind would leave the files table asserting rows the index does not hold.
        _store.DeletePluginFacts(plugin, origin);
        DeleteRegistration(plugin, origin);
        _store.BumpSequence();

        tx.Commit();
    }

    // ADR-0013: one row per registered plugin, carrying its load index.
    private void UpsertRegistration(string plugin, string origin, Registration registration)
    {
        DeleteRegistration(plugin, origin);
        using var cmd = Connection.CreateCommand();
        cmd.CommandText =
            $"INSERT INTO {TableDdlBuilder.RegistrationsRelation} (plugin, origin, load_order_idx, is_light) VALUES ($1, $2, $3, $4)";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        cmd.Parameters.Add(new DuckDBParameter
        {
            Value = registration.LoadOrderIndex is { } loadOrderIndex ? (object)loadOrderIndex : DBNull.Value,
        });
        cmd.Parameters.Add(new DuckDBParameter
        {
            Value = _openedPlugins().TryGetValue(new PluginAddress(plugin, origin), out var content) && content.IsLight,
        });
        cmd.ExecuteNonQuery();
    }

    // ADR-0009: registration is visibility. Every public relation is a view over its `mirror.` table
    // joined to this row, so writing or deleting the row makes a plugin's rows answer or fall
    // silent; neither verb touches a data row.
    public void Register(PluginAddress key, Registration registration)
    {
        using var tx = Connection.BeginTransaction();
        UpsertRegistration(key.Name, key.Origin, registration);
        _store.BumpSequence();
        tx.Commit();
    }

    public void Unregister(PluginAddress key)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Unregistering {Plugin} from {Origin}", key.Name, key.Origin);
        }
        using var tx = Connection.BeginTransaction();
        DeleteRegistration(key.Name, key.Origin);
        _store.BumpSequence();
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.RegisteredPlugins"/>.</summary>
    public IReadOnlyList<PluginAddress> RegisteredPlugins()
    {
        var keys = new List<PluginAddress>();
        using var connection = OpenRead();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT plugin, origin FROM {TableDdlBuilder.RegistrationsRelation}";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            keys.Add(new PluginAddress(reader.GetString(0), reader.GetString(1)));
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
    public void UpdateWinners(IReadOnlyList<RegisteredPlugin> active)
    {
        using var tx = Connection.BeginTransaction();
        ReplaceActive(active);
        UpdateWinnersCore();
        _store.BumpSequence();
        tx.Commit();
    }

    // The same sweep for a projection that moved rows without moving the load order: which plugins
    // are active cannot change here, so the set the last sweep was handed still holds.
    private void ResweepWinners()
    {
        using var tx = Connection.BeginTransaction();
        UpdateWinnersCore();
        _store.BumpSequence();
        tx.Commit();
    }

    // ADR-0013 invariant 3: replaced whole, never diffed. Mod Management decided which plugins are
    // active; nothing here re-asks it.
    private void ReplaceActive(IReadOnlyList<RegisteredPlugin> active)
    {
        Execute($"DELETE FROM {TableDdlBuilder.ActiveRelation}");
        foreach (var (plugin, loadOrderIndex) in active.Select((plugin, index) => (plugin, index)))
        {
            using var cmd = Connection.CreateCommand();
            cmd.CommandText = $"INSERT INTO {TableDdlBuilder.ActiveRelation} (plugin, origin, load_order_idx) VALUES ($1, $2, $3)";
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Name });
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Origin });
            cmd.Parameters.Add(new DuckDBParameter { Value = loadOrderIndex });
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

    // The active plugin latest in the load order wins its FormKey. The join is
    // `active_plugins` alone, so no SQL re-spells who competes; QUALIFY and the (plugin, origin)
    // tiebreak make a load_order_idx tie deterministic.
    private void InsertWinners(RecordRef @ref, string rowsSql) =>
        Execute($"""
            INSERT INTO {TableDdlBuilder.WinnersRelation} (record_ref, form_key, plugin, origin)
            SELECT '{WinnerRef.Of(@ref)}', r.form_key, r.plugin, r.origin
            FROM ({rowsSql}) r
            JOIN {TableDdlBuilder.ActiveRelation} p
              ON p.plugin = r.plugin AND p.origin = r.origin
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY r.form_key
                ORDER BY p.load_order_idx DESC, r.plugin, r.origin) = 1
            """);

    // --- Working-tree changes ---

    /// <summary>The Indexer's landing of re-derived documents: one transaction for the batch, so a
    /// throw partway cannot leave Effective and Head disagreeing. A null body is the document
    /// gone.</summary>
    internal void ProjectDocuments(PluginAddress key, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        if (deltas.Count == 0) return;

        List<string> touched;
        using (var tx = Connection.BeginTransaction())
        {
            // Only a delta that added or removed a row can move winner status. Re-swept for the whole
            // load order rather than per FormKey because UpdateWinners is the one definition of winning
            // (measured at 18 ms over 48k records).
            var projected = RequireWorkingTreeOverlay().ProjectDocuments(key, deltas);
            if (projected.Structural) UpdateWinnersCore();
            touched = projected.Touched;
            _store.BumpSequence();
            tx.Commit();
        }

        // ADR-0015 invariant 3: after the commit, so a subscriber re-reading on receipt sees the rows
        // this names — embedded children included, since a record panel open on a placed ref inside a
        // refreshed cell has no other signal.
        _store.Announce(() => _notifications?.Publish(new RowsChangedNotification(key, touched, Sequence)));
    }

    /// <summary>See <see cref="IRecordIndex.SetCommittedBaseline"/>.</summary>
    public void SetCommittedBaseline(PluginAddress key, IReadOnlyList<(string FormKey, string Body)> baselines)
    {
        if (baselines.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        RequireWorkingTreeOverlay().SetCommittedBaseline(key, baselines);
        _store.BumpSequence();
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.MarkWorkingTreeOnly"/>.</summary>
    public void MarkWorkingTreeOnly(PluginAddress key, IReadOnlyList<string> formKeys)
    {
        if (formKeys.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        RequireWorkingTreeOverlay().MarkWorkingTreeOnly(key, formKeys);
        // Effective is untouched, but Head just lost a row per FormKey, which can promote the next
        // plugin down at that ref; Head's winners are swept, not derived per read (ADR-0009).
        UpdateWinnersCore();
        _store.BumpSequence();
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.SeedCommittedOnly"/>. One transaction for the whole batch:
    /// the three head-state writes are all-or-nothing together, so a throw partway through a
    /// reconciliation pass cannot leave half of one applied.</summary>
    public void SeedCommittedOnly(PluginAddress key, IReadOnlyList<(string FormKey, string RecordType, string Body)> records)
    {
        if (records.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        RequireWorkingTreeOverlay().SeedCommittedOnly(key, records);
        // The counterpart of MarkWorkingTreeOnly's sweep: Head just gained a row per FormKey, which can
        // demote whoever was winning it at that ref. Effective is untouched either way.
        UpdateWinnersCore();
        _store.BumpSequence();
        tx.Commit();
    }

    // --- Refresh ---

    /// <summary>See <see cref="IRecordIndex.RefreshByKeys"/>.</summary>
    public void RefreshByKeys(PluginAddress key, string modFolder, IReadOnlyList<string> formKeys)
    {
        // One signal, one advance, however many documents and refs it moves.
        using var projection = BeginProjection();

        // The tree is what these rows are re-derived from, so it is what the plugin is derived from
        // (ADR-0007 invariant 3), bytes moved or not: a plugin tracked after indexing arrives here
        // still stamped from its binary.
        if (SourceRepository.HoldsTreeFor(modFolder, key.Name))
            _store.RestampDerivation(key, DerivedFrom.SourceTree);

        // A key at neither ref is a record the tree has gained, and no document says where the tree
        // puts it: a new exterior cell's block is a directory, not a field.
        if (formKeys.Any(formKey => StoredRow(EffectiveRows, key, formKey) == null
                                    && StoredRow(TableDdlBuilder.HeadRowsRelation, key, formKey) == null))
        {
            RederiveWholePluginFromSource(key, modFolder, formKeys);
            return;
        }

        // One repository for the batch, so its listing memo and embedded-owner map are built once
        // rather than once per key.
        var repository = SourceRepository.Over(modFolder, _release);
        foreach (var formKey in formKeys)
            RefreshOneKey(repository, key, formKey);
    }

    // Re-derives one key's rows at both refs. Called again with the same bytes, nothing below fires.
    private void RefreshOneKey(SourceRepository repository, PluginAddress key, string formKey)
    {
        var effective = StoredRow(EffectiveRows, key, formKey);
        var head = StoredRow(TableDdlBuilder.HeadRowsRelation, key, formKey);
        // Gone from both refs since the batch was read: another key's projection in this same batch
        // took it (a container's document carries its children's rows).
        var recordType = effective?.RecordType ?? head?.RecordType;
        if (recordType == null) return;

        var identity = new RecordIdentity(formKey, recordType, effective?.EditorId ?? head?.EditorId);
        var workingTreeText = repository.Get(key, identity)?.Body;

        // Never exclusive owners of the file: it can be caught mid-save, or hand-edited into
        // something that is not a document. Rows stay as they stand until it reads as one again, and
        // the caller says why.
        if (workingTreeText != null && !IsDocument(workingTreeText))
        {
            throw new UnreadableSourceDocumentException(
                $"The source of {formKey} in {key.Name} ({key.Origin}) is not a readable document.");
        }

        if (!string.Equals(workingTreeText, effective?.Body, StringComparison.Ordinal))
            ProjectDocuments(key, [(formKey, workingTreeText)]);

        // Re-read, since the projection above may have moved this record's committed row too. Asked
        // only for a record the index already believes dirty.
        if (StoredRow(TableDdlBuilder.HeadRowsRelation, key, formKey)?.Body is { } committedBody
            && repository.CommittedTextIfMoved(key, identity, committedBody) is { } movedText)
        {
            SetCommittedBaseline(key, [(formKey, movedText)]);
        }
    }

    private const string EffectiveRows = $"{TableDdlBuilder.MirrorSchema}.records";

    // A file changing is its own event (ADR-0009 invariant 1), so the projection reads the plugin's
    // rows whether it is active or not.
    private (string RecordType, string? EditorId, string Body)? StoredRow(string relation, PluginAddress key, string formKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT record_type, editor_id, body FROM {relation} WHERE form_key = $1 AND plugin = $2 AND origin = $3";
        DuckDbSql.AddParams(cmd, [formKey, key.Name, key.Origin]);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;
        return (reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1), reader.GetString(2));
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
    private void RederiveWholePluginFromSource(PluginAddress key, string modFolder, IReadOnlyList<string> formKeys)
    {
        // Nothing to re-derive from: the tree went away between the signal and this line, or this
        // plugin's rows came from its binary and a source key is not its to answer for.
        if (!SourceRepository.HoldsTreeFor(modFolder, key.Name)) return;
        if (RegistrationOf(key) is not { } registration) return;

        // Ingest, head reconcile and winner sweep are one whole-plugin projection, so they are one
        // advance and the notification below carries the number a subscriber can await.
        var before = EffectiveContentHashes(key);
        using (BeginProjection())
        {
            SourceIngest.Ingest(
                this, modFolder, registration, key, _store.IndexedFile(key)?.FilePath,
                _release, _schemaReflector, _logger);
            ResweepWinners();
        }
        var after = EffectiveContentHashes(key);

        // ADR-0015 invariant 3: the keys asked about, and every row the tree read again moved, gone
        // or gained, at the sequence it landed on.
        var moved = before.Keys.Union(after.Keys, StringComparer.Ordinal)
            .Where(formKey => !before.TryGetValue(formKey, out var was) || !after.TryGetValue(formKey, out var now) || was != now);
        PublishRowsChanged(key, [.. formKeys.Union(moved, StringComparer.Ordinal)]);
    }

    private Dictionary<string, string> EffectiveContentHashes(PluginAddress key)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT form_key, content_hash FROM {EffectiveRows} WHERE plugin = $1 AND origin = $2";
        DuckDbSql.AddParams(cmd, [key.Name, key.Origin]);
        using var reader = cmd.ExecuteReader();
        var hashes = new Dictionary<string, string>(StringComparer.Ordinal);
        while (reader.Read()) hashes[reader.GetString(0)] = reader.GetString(1);
        return hashes;
    }

    // What the plugin's registration row carries (ADR-0013), read back for a re-ingest that must not
    // change what the load order said about this plugin.
    private Registration? RegistrationOf(PluginAddress key)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText =
            $"SELECT load_order_idx FROM {TableDdlBuilder.RegistrationsRelation} WHERE plugin = $1 AND origin = $2";
        DuckDbSql.AddParams(cmd, [key.Name, key.Origin]);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;
        return new Registration(reader.IsDBNull(0) ? null : reader.GetInt32(0));
    }

    // --- Validate ---

    /// <summary>See <see cref="IRecordIndex.Validate"/>.</summary>
    public ValidationReport Validate(PluginAddress key, string? modFolder)
    {
        var sourceValidation = _sourceValidation ?? throw new InvalidOperationException("Call Initialize before using the repository.");
        if (modFolder != null && SourceRepository.HoldsTreeFor(modFolder, key.Name))
            return sourceValidation.Validate(key, modFolder);

        // Whatever HEAD vouched for is gone with the tree, so a tree that returns is read whole.
        sourceValidation.Forget(key);
        return ValidateAgainstBinary(key);
    }

    /// <summary>Restates which truth <paramref name="key"/>'s rows read as, for Validate's tracked
    /// half.</summary>
    internal void RestampDerivation(PluginAddress key, DerivedFrom derivedFrom) =>
        _store.RestampDerivation(key, derivedFrom);

    // Validate's own publish. MarkWorkingTreeOnly does not publish for itself: ingest calls it for
    // every reconciled record of a whole plugin, where a notification per record would be noise.
    internal void PublishRowsChanged(PluginAddress key, IReadOnlyList<string> formKeys) =>
        _store.Announce(() => _notifications?.Publish(new RowsChangedNotification(key, formKeys, Sequence)));

    // ADR-0009's load-time check, asked of one plugin: the stored hash against the bytes on disk. A
    // binary has no smaller unit, so a mismatch is a rebuild the caller owns.
    private ValidationReport ValidateAgainstBinary(PluginAddress key)
    {
        // Nothing vouches for these rows (an in-memory mod, or a tracked plugin whose folder went
        // away), so there is nothing to compare them against.
        if (_store.IndexedFile(key) is not { } claim) return ValidationReport.Clean(key);

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

        // Reached only for a plugin no repository holds, so rows stamped from a source tree came from
        // one destroyed outside Modbench (ADR-0007 invariant 2), which the caller re-derives.
        if (_store.DerivationOf(key) == DerivedFrom.SourceTree)
            return new ValidationReport(key, [], NeedsRebuild: true, []);

        return _store.FileContentHash(claim.FilePath) == claim.ContentHash
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

    // Empty until the Indexer points it somewhere: a store opened by a test that never reconciles
    // has no plugins open, which is what an empty set says.
    private Func<IReadOnlyDictionary<PluginAddress, PluginContent>> _openedPlugins =
        () => new Dictionary<PluginAddress, PluginContent>();

    public void ReadOpenedPluginsFrom(Func<IReadOnlyDictionary<PluginAddress, PluginContent>> opened) =>
        _openedPlugins = opened;

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
        public IReadOnlyDictionary<PluginAddress, PluginContent> OpenedPlugins => owner._openedPlugins();

        // A SELECT COUNT(*) always answers exactly one row with a non-null count.
        private static long ExecuteCount(DuckDBCommand cmd) =>
            (long)(cmd.ExecuteScalar() ?? throw new InvalidOperationException("Expected SELECT COUNT(*) to return a value."));

        public RecordDocument? GetDocument(string formKey)
        {
            using var connection = owner.OpenRead();
            owner.RequireSchemas(); // fails before any query runs, though OpenRead above has already opened the connection
            var tableName = FindRecordType(connection, records, formKey);
            return tableName == null ? null : owner.ReadDocument(connection, records, tableName, formKey, plugin: null, origin: null, winnerOnly: true);
        }

        public RecordDocument? GetDocument(string formKey, PluginAddress plugin)
        {
            using var connection = owner.OpenRead();
            owner.RequireSchemas();
            var tableName = FindRecordType(connection, records, formKey);
            return tableName == null ? null : owner.ReadDocument(connection, records, tableName, formKey, plugin.Name, plugin.Origin, winnerOnly: false);
        }

        // One query rather than two point queries per record. Rows are materialized before
        // reconstitution: resolving a FormKey opens its own command on this connection, which would
        // interleave two readers.
        public IReadOnlyList<RecordDocument> GetDocuments(PluginAddress plugin)
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

            var resolve = LinkResolution.ForLinksOf(connection, plugin);

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
            var resolve = LinkResolution.ForLinksOf(connection, formKey);
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

        private string? ListingFilter => owner._filterActive ? KeptByFilter("r") : null;

        private string InListingFilter(string alias, string formKeyColumn = "form_key") =>
            owner._filterActive ? $" AND {KeptByFilter(alias, formKeyColumn)}" : "";

        private static string KeptByFilter(string alias, string formKeyColumn = "form_key") => $"""
            ({alias}.{formKeyColumn} IN (SELECT form_key FROM {FilterMatches})
             OR EXISTS (SELECT 1 FROM {FilterHolders} fh
                        WHERE fh.form_key = {alias}.{formKeyColumn} AND fh.plugin = {alias}.plugin AND fh.origin = {alias}.origin))
            """;


        public PagedResult<RecordSummary> Search(RecordQuery query)
        {
            using var connection = owner.OpenRead();
            var (where, paramValues) = BuildWhere(
                query.Plugin?.Name, query.Search, query.Unfiltered ? null : ListingFilter, query.Origin, query.RecordTypes,
                query.GroupOnly ? NavigatorSql.NotHeld("r") : null, query.SearchFormKey);
            var dataParams = new List<string>(paramValues);
            var holdings = HoldingsOf(query.Plugin?.Name, query.Origin, dataParams);
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
                      {(query.Unfiltered ? "" : InListingFilter("cc", "child_form_key"))}
                ) AS has_container_children,
                r.parse_diagnosis,
                r.parse_diagnosis IS NOT NULL OR EXISTS (
                    SELECT 1 FROM above_failure a
                    WHERE a.form_key = r.form_key AND a.plugin = r.plugin AND a.origin = r.origin
                ) AS has_parse_failure,
                {FullNameOf("r")} AS full_name
                """;

            using var countCmd = connection.CreateCommand();
            countCmd.CommandText = $"SELECT COUNT(*) FROM {records} r{where}";
            AddParams(countCmd, paramValues);
            var total = ExecuteCount(countCmd);

            // xEdit's navigator lists a group in FormID order, and its record picker lists by EditorID.
            // (plugin, origin) makes either order total, so LIMIT/OFFSET pages stably.
            var order = query.GroupOnly ? NavigatorSql.FormIdOrder("form_key") : "editor_id, form_key";
            using var dataCmd = connection.CreateCommand();
            dataCmd.CommandText = $"""
                WITH RECURSIVE {NavigatorSql.AboveAFailure(records, holdings)}
                SELECT {cols} FROM {records} r{where}
                ORDER BY {order}, plugin, origin
                LIMIT {query.Limit} OFFSET {query.Offset}
                """;
            AddParams(dataCmd, dataParams);

            var items = new List<RecordSummary>();
            using var reader = dataCmd.ExecuteReader();
            while (reader.Read())
                items.Add(ReadSummary(reader));

            return new PagedResult<RecordSummary>(items, (int)total);
        }

        // A listing of one plugin walks that plugin's holdings alone, bound after the listing's own
        // parameters.
        private static string HoldingsOf(string? plugin, string? origin, List<string> paramValues)
        {
            var conditions = new List<string>();
            if (plugin != null)
            {
                paramValues.Add(plugin);
                conditions.Add($"h.plugin = ${paramValues.Count}");
            }
            if (origin != null)
            {
                paramValues.Add(origin);
                conditions.Add($"h.origin = ${paramValues.Count}");
            }
            return conditions.Count == 0 ? "" : "WHERE " + string.Join(" AND ", conditions);
        }

        // The filter narrows counts the same way it narrows listings (invariant: SetFilter affects
        // Search/counts/plugin-highlight, never a point read), routed through the same BuildWhere
        // every other filterable query here uses.
        public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginAddress plugin)
        {
            using var connection = owner.OpenRead();
            var (where, paramValues) = BuildWhere(
                plugin.Name, null, ListingFilter, plugin.Origin, recordTypes: null, NavigatorSql.NotHeld("r"));
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT record_type, COUNT(*), BOOL_OR(parse_diagnosis IS NOT NULL)
                FROM {records} r{where}
                GROUP BY record_type
                """;
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
            var holdingAFailure = TypesHoldingAFailure(connection, plugin);
            for (var i = 0; i < counts.Count; i++)
            {
                if (failedTypes.Contains(counts[i].Type) || holdingAFailure.Contains(counts[i].Type))
                    counts[i] = counts[i] with { HasParseFailure = true };
            }
            counts.AddRange(failedTypes
                .Where(t => !counts.Exists(c => string.Equals(c.Type, t, StringComparison.OrdinalIgnoreCase)))
                .Select(t => new RecordTypeCount(t, 0, HasParseFailure: true)));
            return counts;
        }

        // The types of the listed records with an unreadable record anywhere beneath them, walked up
        // the holdings from each unreadable record.
        private HashSet<string> TypesHoldingAFailure(DuckDBConnection connection, PluginAddress plugin)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                WITH RECURSIVE {NavigatorSql.AboveAFailure(records, "WHERE h.plugin = $1 AND h.origin = $2")}
                SELECT DISTINCT r.record_type FROM {records} r
                JOIN above_failure a ON a.form_key = r.form_key AND a.plugin = r.plugin AND a.origin = r.origin
                WHERE r.plugin = $1 AND r.origin = $2 AND {NavigatorSql.NotHeld("r")}
                """;
            AddParams(cmd, [plugin.Name, plugin.Origin]);
            using var reader = cmd.ExecuteReader();

            var types = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (reader.Read()) types.Add(reader.GetString(0));
            return types;
        }

        // Unfiltered: a record filter narrows what is listed, never whether a type could be read.
        private static HashSet<string> FailedRecordTypes(DuckDBConnection connection, PluginAddress plugin)
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
            return LinkResolution.Resolve(connection, formKey);
        }

        public IReadOnlyList<ReferenceRow> GetReferencedBy(string targetFormKey)
        {
            using var connection = owner.OpenRead();
            return GetReferences(connection, targetFormKey);
        }

        public IReadOnlySet<PluginAddress> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames)
        {
            var types = tableNames.ToList();
            if (types.Count == 0 || !owner._filterActive)
                return new HashSet<PluginAddress>(PluginAddress.Comparer);

            using var connection = owner.OpenRead();

            var (where, paramValues) = BuildWhere(
                null, null, $"form_key IN (SELECT form_key FROM {FilterMatches})", origin: null, recordTypes: types);

            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"SELECT DISTINCT plugin, origin FROM {records}{where}";
            AddParams(cmd, paramValues);
            using var reader = cmd.ExecuteReader();

            var result = new HashSet<PluginAddress>(PluginAddress.Comparer);
            while (reader.Read())
                result.Add(new PluginAddress(reader.GetString(0), reader.GetString(1)));
            return result;
        }

        public IReadOnlyList<PluginDiagnosisRow> GetPluginDiagnoses()
        {
            using var connection = owner.OpenRead();
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT plugin, origin, anchor, defect_class, tail, message
                FROM {TableDdlBuilder.PluginDiagnosisTable}
                ORDER BY plugin, origin, ordinal
                """;
            using var reader = cmd.ExecuteReader();

            var rows = new List<PluginDiagnosisRow>();
            while (reader.Read())
            {
                rows.Add(new PluginDiagnosisRow(
                    new PluginAddress(reader.GetString(0), reader.GetString(1)),
                    new PluginDiagnosis(
                        reader.IsDBNull(2) ? null : reader.GetString(2),
                        reader.GetString(3),
                        reader.IsDBNull(4) ? null : reader.GetString(4),
                        reader.GetString(5))));
            }
            return rows;
        }

        public IReadOnlySet<PluginAddress> GetTrackedPlugins()
        {
            using var connection = owner.OpenRead();
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"SELECT plugin, origin FROM {TableDdlBuilder.PluginDerivationTable} WHERE derived_from = $1";
            AddParams(cmd, [DerivedFrom.SourceTree.ToString()]);
            using var reader = cmd.ExecuteReader();

            var tracked = new HashSet<PluginAddress>(PluginAddress.Comparer);
            while (reader.Read())
                tracked.Add(new PluginAddress(reader.GetString(0), reader.GetString(1)));
            return tracked;
        }

        /// <summary>Both halves of "could not be read": a record whose own document failed, and a
        /// record type whose enumeration did. Keyed by <c>ColumnKey.Of</c> rather than a bare
        /// filename, which two loaded plugins can share.</summary>
        public IReadOnlySet<string> GetPluginsWithParseFailures()
        {
            using var connection = owner.OpenRead();
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT DISTINCT r.plugin, r.origin FROM {EffectiveRows} r
                {TableDdlBuilder.RegisteredJoin("r", "plugin", "origin")}
                WHERE r.parse_diagnosis IS NOT NULL
                UNION
                SELECT DISTINCT plugin, origin FROM record_type_failure
                """;
            using var reader = cmd.ExecuteReader();

            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (reader.Read())
                result.Add(ColumnKey.Of(reader.GetString(0), reader.GetString(1)));
            return result;
        }

        public IReadOnlyList<string> GetNativeFormKeys(PluginAddress plugin)
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

        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginAddress plugin, string worldspaceFormKey) =>
            CellLocations(plugin, "cl.parent_worldspace = $3", "cl.block_x, cl.block_y, cl.sub_x, cl.sub_y", [worldspaceFormKey]);

        public IReadOnlyList<CellLocationSummary> GetInteriorCells(PluginAddress plugin) =>
            CellLocations(plugin, "cl.is_interior", "cl.block_x, cl.sub_x", []);

        private List<CellLocationSummary> CellLocations(
            PluginAddress plugin, string where, string blockOrder, IEnumerable<string> parameters)
        {
            using var connection = owner.OpenRead();
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                WITH RECURSIVE {NavigatorSql.AboveAFailure(records, "WHERE h.plugin = $1 AND h.origin = $2")}
                SELECT cl.cell_form_key, c.editor_id, cl.block_x, cl.block_y, cl.sub_x, cl.sub_y, cl.grid_x, cl.grid_y,
                       {FullNameOf("c")}, c.parse_diagnosis,
                       c.parse_diagnosis IS NOT NULL OR EXISTS (
                           SELECT 1 FROM above_failure a
                           WHERE a.form_key = cl.cell_form_key AND a.plugin = cl.plugin AND a.origin = cl.origin
                       ),
                       EXISTS (
                           SELECT 1 FROM ({NavigatorSql.CellChildren}) p
                           JOIN {records} pr ON pr.form_key = p.form_key AND pr.plugin = p.plugin AND pr.origin = p.origin
                           WHERE p.parent_cell = cl.cell_form_key AND p.plugin = cl.plugin AND p.origin = cl.origin
                             {InListingFilter("p")}
                       )
                FROM cell_location cl
                LEFT JOIN {records} c ON c.form_key = cl.cell_form_key AND c.plugin = cl.plugin AND c.origin = cl.origin
                WHERE cl.plugin = $1 AND cl.origin = $2 AND {where}{InListingFilter("cl", "cell_form_key")}
                ORDER BY {blockOrder}, {NavigatorSql.FormIdOrder("cl.cell_form_key")}
                """;
            AddParams(cmd, [plugin.Name, plugin.Origin, .. parameters]);
            using var reader = cmd.ExecuteReader();

            int? NullableInt(int i) => reader.IsDBNull(i) ? null : reader.GetInt32(i);
            var rows = new List<CellLocationSummary>();
            while (reader.Read())
            {
                rows.Add(new CellLocationSummary(
                    reader.GetString(0),
                    reader.IsDBNull(1) ? null : reader.GetString(1),
                    NullableInt(2), NullableInt(3), NullableInt(4), NullableInt(5), NullableInt(6), NullableInt(7),
                    FullName: reader.IsDBNull(8) ? null : reader.GetString(8),
                    ParseDiagnosis: reader.IsDBNull(9) ? null : reader.GetString(9),
                    HasParseFailure: reader.GetBoolean(10),
                    HasChildren: reader.GetBoolean(11)));
            }

            return rows;
        }

        public IReadOnlySet<string> GetWorldspacesHoldingCells(PluginAddress plugin)
        {
            using var connection = owner.OpenRead();
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT DISTINCT cl.parent_worldspace FROM cell_location cl
                WHERE cl.parent_worldspace IS NOT NULL AND cl.plugin = $1 AND cl.origin = $2{InListingFilter("cl", "cell_form_key")}
                """;
            AddParams(cmd, [plugin.Name, plugin.Origin]);
            using var reader = cmd.ExecuteReader();

            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (reader.Read()) result.Add(reader.GetString(0));
            return result;
        }

        public CellReferences GetCellReferences(PluginAddress plugin, string cellFormKey)
        {
            var schemas = owner.RequireSchemas();
            var cellChildTypes = CellChildTypeNames.Where(schemas.ContainsKey).ToList();
            if (cellChildTypes.Count == 0)
                return new CellReferences([], []);

            using var connection = owner.OpenRead();

            // ADR-0007: the placed ref's base form comes out of the document rather than a `base`
            // column; json_extract_string unquotes the stored FormLink text, and a placed ref with no
            // base reads NULL.
            var typeList = string.Join(", ", cellChildTypes.Select(t => $"'{t}'"));

            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT p.placement_group, r.record_type, p.form_key, r.editor_id,
                       json_extract_string(r.body, '$.Base'), r.parse_diagnosis IS NOT NULL, {FullNameOf("r")},
                       r.parse_diagnosis,
                       -- ADR-0012: the reference's own plugin's copy of its base, else the winning copy.
                       (SELECT b.editor_id FROM {records} b
                        WHERE b.form_key = json_extract_string(r.body, '$.Base')
                        ORDER BY (b.plugin = r.plugin AND b.origin = r.origin) DESC, b.is_winner DESC, b.plugin, b.origin
                        LIMIT 1)
                FROM ({NavigatorSql.CellChildren}) p
                JOIN {records} r ON r.form_key = p.form_key AND r.plugin = p.plugin AND r.origin = p.origin
                WHERE p.parent_cell = $1 AND p.plugin = $2 AND p.origin = $3
                  AND r.record_type IN ({typeList}){InListingFilter("p")}
                ORDER BY {NavigatorSql.FormIdOrder("p.form_key")}
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
                    HasParseFailure: reader.GetBoolean(5),
                    FullName: reader.IsDBNull(6) ? null : reader.GetString(6),
                    ParseDiagnosis: reader.IsDBNull(7) ? null : reader.GetString(7),
                    BaseEditorId: reader.IsDBNull(8) ? null : reader.GetString(8));
                (group == "persistent" ? persistent : temporary).Add(summary);
            }
            return new CellReferences(persistent, temporary);
        }

        public PlacementRow? GetPlacement(string formKey, PluginAddress plugin)
        {
            using var connection = owner.OpenRead();
            return GetPlacement(connection, formKey, plugin.Name, plugin.Origin);
        }

        public CellLocationRow? GetCellLocation(PluginAddress plugin, string cellFormKey)
        {
            using var connection = owner.OpenRead();
            return GetCellLocation(connection, cellFormKey, plugin.Name, plugin.Origin);
        }

        public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginAddress plugin, string parentFormKey)
        {
            using var connection = owner.OpenRead();
            return GetContainerChildren(
                connection, plugin.Name, plugin.Origin, parentFormKey, InListingFilter("cc", "child_form_key"), NavigatorSql.FormIdOrder("cc.child_form_key"));
        }

        public ContainerChildRow? GetContainerParent(PluginAddress plugin, string childFormKey)
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
        // own diagnosis, 10 the same fact widened to its children and 11 its FULL, read
        // positionally like 6/7.
        private static RecordSummary ReadSummary(DuckDBDataReader reader) =>
            new(reader.GetString(0), reader.GetString(1), LoadOrderSortKey(reader, 2),
                reader.GetBoolean(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetString(5),
                ReadWorkingTreeState(reader), reader.GetBoolean(8),
                reader.IsDBNull(9) ? null : reader.GetString(9), reader.GetBoolean(10),
                FullName: reader.IsDBNull(11) ? null : reader.GetString(11));

        private static string FullNameOf(string alias) =>
            $"NULLIF({TranslatedStringSql.Resolved($"{alias}.body", "$.Name")}, '')";

        // origin (ADR-0012): nullable and independent of plugin — a *filter*, not an identity field.
        // This builder doesn't enforce invariant 1 itself; every live caller already passes both or
        // neither.
        private static (string where, List<string> paramValues) BuildWhere(
            string? plugin, string? search, string? filterCondition = null, string? origin = null,
            IReadOnlyList<string>? recordTypes = null, string? groupCondition = null, string? searchFormKey = null)
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
                // A FormKey-shaped query resolves against form_key rather than an EditorID substring
                // match; form_key values are stored via FormKey.ToString(), so round-tripping the
                // query through TryFactory canonicalizes its hex id.
                var matches = new List<string>();
                if (Mutagen.Bethesda.Plugins.FormKey.TryFactory(search, out var formKey))
                {
                    matches.Add($"form_key = ${values.Count + 1}");
                    values.Add(formKey.ToString());
                }
                else
                {
                    matches.Add($"editor_id ILIKE ${values.Count + 1}");
                    values.Add($"%{search}%");
                }
                if (searchFormKey != null)
                {
                    matches.Add($"form_key = ${values.Count + 1}");
                    values.Add(searchFormKey);
                }
                conditions.Add($"({string.Join(" OR ", matches)})");
            }
            if (filterCondition != null)
                conditions.Add(filterCondition);
            if (groupCondition != null)
                conditions.Add(groupCondition);

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

        private static List<ReferenceRow> GetReferences(DuckDBConnection connection, string targetFormKey)
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

            var results = new List<ReferenceRow>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                results.Add(new ReferenceRow(
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

        private static List<ContainerChildRow> GetContainerChildren(
            DuckDBConnection connection, string plugin, string origin, string parentFormKey, string inFilter, string order)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT cc.child_form_key, cc.parent_record_type, cc.slot_name, cc.slot_index
                FROM container_child cc
                WHERE cc.parent_form_key = $1 AND cc.plugin = $2 AND cc.origin = $3{inFilter}
                ORDER BY {order}
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

        var resolve = LinkResolution.ForLinksOf(connection, formKey);
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, parse_diagnosis
            FROM {records} WHERE {string.Join(" AND ", conditions)}
            LIMIT 1
            """;
        AddParams(cmd, values);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;

        return ReadDocumentFromBody(reader, schema, resolve);
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
            formKey, new PluginAddress(plugin, origin), loadOrderIndex, isWinner, editorId, schema.TableName,
            body, BuildFields(schema, root, resolveFormKey, _release),
            // A ModHeader cannot carry the Partial Form flag.
            IsPartialForm: !schema.IsHeader && PartialFormFlag.IsSet(root, schema.RecordType),
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

        if (SqlDoor.RefusalOf(Connection, sql) is { } refusal)
            throw new ArgumentException(refusal);

        CreateRecordTypeViews();
        using var probeCmd = Connection.CreateCommand();
        // The newline keeps a trailing line comment in the filter from swallowing the wrapper.
        probeCmd.CommandText = $"SELECT * FROM ({sql}\n) __probe LIMIT 0";
        using var probeReader = probeCmd.ExecuteReader();
        bool hasFormKey = Enumerable.Range(0, probeReader.FieldCount)
            .Any(i => string.Equals(probeReader.GetName(i), "form_key", StringComparison.OrdinalIgnoreCase));

        if (!hasFormKey)
            throw new ArgumentException("Filter SQL must return a form_key column");

        Execute($"CREATE OR REPLACE TABLE {FilterMatches} AS ({sql}\n)");
        Execute($"""
            CREATE OR REPLACE TABLE {FilterHolders} AS
            WITH RECURSIVE held AS (SELECT plugin, origin, parent, child FROM ({NavigatorSql.Held}) h),
            holders(plugin, origin, form_key) AS (
                SELECT held.plugin, held.origin, held.parent FROM held
                JOIN {FilterMatches} m ON held.child = m.form_key
                UNION
                SELECT held.plugin, held.origin, held.parent FROM held
                JOIN holders h ON held.child = h.form_key AND held.plugin = h.plugin AND held.origin = h.origin
            )
            SELECT plugin, origin, form_key FROM holders
            """);
        _filterActive = true;
    }

    public void Dispose() => _store.Dispose();
}
