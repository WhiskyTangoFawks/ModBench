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

    // Constructed rather than injected: it is stateless apart from static reflection caches, and
    // every construction site would otherwise learn a dependency it has no say in.
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

    // Null in every test that does not care.
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

    // ADR-0010: the rebuild's whole job on an already-opened index — construction
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

    // ADR-0012.
    private void Index(
        IPluginDocuments documents, Registration registration, string plugin, string origin, string? filePath,
        DerivedFrom derivedFrom)
    {
        var schemas = RequireSchemas();

        // One transaction for the whole reindex so a throw partway leaves the read model intact
        // rather than a partial snapshot. DuckDB appenders enroll in the active transaction, so
        // deletes and appender flushes roll back together on Dispose-without-Commit.
        using var tx = Connection.BeginTransaction();

        // The `registrations` row lands in the same transaction as the rows, which answer nothing
        // without it.
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

    // Neither verb touches a data row: which rows answer is TableDdlBuilder.RegistrationsRelation's.
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
    /// registering a plugin can move the winner of every FormKey it holds. Measured at ~75 ms
    /// on a 48,000-record, 60-plugin fixture.</summary>
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

    // Replaced whole, never diffed (ADR-0013).
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

        // form_lookup gets no branch: ingest keeps one lookup row per `records` row, so `records`'
        // winners are form_lookup's. QUALIFY and the (plugin, origin) tiebreak make a load_order_idx
        // tie deterministic.
        Execute($"""
            INSERT INTO {TableDdlBuilder.WinnersRelation} (form_key, plugin, origin)
            SELECT r.form_key, r.plugin, r.origin
            FROM mirror.records r
            JOIN {TableDdlBuilder.ActiveRelation} p
              ON p.plugin = r.plugin AND p.origin = r.origin
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY r.form_key
                ORDER BY p.load_order_idx DESC, r.plugin, r.origin) = 1
            """);
    }

    // --- Working-tree changes ---

    /// <summary>The Indexer's landing of re-derived documents: one transaction for the batch, so a
    /// throw partway cannot leave the rows half-projected. A null body is the document gone. Returns
    /// every key whose rows moved, embedded children included, for the caller to announce (ADR-0015).</summary>
    private List<string> ProjectDocuments(PluginAddress key, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        if (deltas.Count == 0) return [];

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

        return touched;
    }

    /// <summary>See <see cref="IRecordIndex.LearnWorkingTreeStates"/>.</summary>
    public IReadOnlyList<string> LearnWorkingTreeStates(PluginAddress key, string modFolder)
    {
        var changes = SourceRepository.Over(modFolder, _release)
            .ChangedSinceLastCommit(key, _schemaReflector.GetSchemas(_release));

        var learned = changes
            .Where(change => change.Value != RecordChange.Deleted)
            .ToDictionary(
                change => change.Key,
                change => change.Value == RecordChange.Added ? WorkingTreeState.Added : WorkingTreeState.Modified,
                StringComparer.Ordinal);
        var held = HeldWorkingTreeStates(key);
        var moved = held.Keys.Except(learned.Keys, StringComparer.Ordinal)
            .Select(formKey => (FormKey: formKey, State: WorkingTreeState.None))
            .Concat(learned.Where(l => held.GetValueOrDefault(l.Key) != l.Value).Select(l => (FormKey: l.Key, State: l.Value)))
            .ToList();
        if (moved.Count == 0) return [];

        using (var tx = Connection.BeginTransaction())
        {
            foreach (var (formKey, state) in moved)
            {
                DuckDbSql.ExecuteFor(Connection, $"""
                    UPDATE {EffectiveRows} SET working_tree_state = $4
                    WHERE form_key = $1 AND plugin = $2 AND origin = $3
                    """, formKey, key.Name, key.Origin, state.Stored());
            }
            _store.BumpSequence();
            tx.Commit();
        }
        return [.. moved.Select(m => m.FormKey)];
    }

    private Dictionary<string, WorkingTreeState> HeldWorkingTreeStates(PluginAddress key)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT form_key, working_tree_state FROM {EffectiveRows}
            WHERE plugin = $1 AND origin = $2 AND working_tree_state <> '{WorkingTreeState.None.Stored()}'
            """;
        DuckDbSql.AddParams(cmd, [key.Name, key.Origin]);
        using var reader = cmd.ExecuteReader();
        var held = new Dictionary<string, WorkingTreeState>(StringComparer.Ordinal);
        while (reader.Read()) held[reader.GetString(0)] = WorkingTreeStates.FromStored(reader.GetString(1));
        return held;
    }

    // --- Refresh ---

    /// <summary>See <see cref="IRecordIndex.RefreshByKeys"/>.</summary>
    public void RefreshByKeys(PluginAddress key, string modFolder, IReadOnlyList<string> formKeys)
    {
        // One signal, one advance, however many documents and refs it moves.
        using var projection = BeginProjection();

        // The tree is what these rows are re-derived from, so it is what the plugin is derived from
        // (ADR-0007), bytes moved or not: a plugin tracked after indexing arrives here
        // still stamped from its binary.
        if (SourceRepository.HoldsTreeFor(modFolder, key.Name))
            _store.RestampDerivation(key, DerivedFrom.SourceTree);

        // A key the index does not hold is a record the tree has gained or got back, and no document
        // says where the tree puts it: a new exterior cell's block is a directory, not a field.
        if (formKeys.Any(formKey => StoredRow(key, formKey) == null))
        {
            RederiveWholePluginFromSource(key, modFolder, formKeys);
            return;
        }

        // One repository for the batch, so its listing memo and embedded-owner map are built once
        // rather than once per key.
        var repository = SourceRepository.Over(modFolder, _release);
        var touched = new List<string>();
        foreach (var formKey in formKeys)
            touched.AddRange(RefreshOneKey(repository, key, formKey));
        touched.AddRange(LearnWorkingTreeStates(key, modFolder));

        // ADR-0015: after the commit, so a subscriber re-reading on receipt sees the rows this names.
        // Embedded children are named, since a record panel open on a placed ref inside a refreshed
        // cell has no other signal.
        if (touched.Count > 0) PublishRowsChanged(key, [.. touched.Distinct(StringComparer.Ordinal)]);
    }

    // Re-derives one key's rows. Called again with the same bytes, nothing below fires.
    private List<string> RefreshOneKey(SourceRepository repository, PluginAddress key, string formKey)
    {
        // Gone since the batch was read: another key's projection in this same batch took it (a
        // container's document carries its children's rows).
        if (StoredRow(key, formKey) is not { } effective) return [];

        var identity = new RecordIdentity(formKey, effective.RecordType, effective.EditorId);
        var workingTreeText = repository.Get(key, identity)?.Body;

        // Never exclusive owners of the file: it can be caught mid-save, or hand-edited into
        // something that is not a document. Rows stay as they stand until it reads as one again, and
        // the caller says why.
        if (workingTreeText != null && !IsDocument(workingTreeText))
        {
            throw new UnreadableSourceDocumentException(
                $"The source of {formKey} in {key.Name} ({key.Origin}) is not a readable document.");
        }

        return string.Equals(workingTreeText, effective.Body, StringComparison.Ordinal)
            ? []
            : ProjectDocuments(key, [(formKey, workingTreeText)]);
    }

    private const string EffectiveRows = $"{TableDdlBuilder.MirrorSchema}.records";

    // The projection reads the plugin's rows whether it is active or not (ADR-0012).
    private (string RecordType, string? EditorId, string Body)? StoredRow(PluginAddress key, string formKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT record_type, editor_id, body FROM {EffectiveRows} WHERE form_key = $1 AND plugin = $2 AND origin = $3";
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
        var statesBefore = HeldWorkingTreeStates(key);
        using (BeginProjection())
        {
            SourceIngest.Ingest(
                this, modFolder, registration, key, _store.IndexedFile(key)?.FilePath,
                _release, _schemaReflector, _logger);
            ResweepWinners();
        }
        var after = EffectiveContentHashes(key);
        var statesAfter = HeldWorkingTreeStates(key);

        // ADR-0015: the keys asked about, and every row the tree read again moved, gone
        // or gained, at the sequence it landed on.
        var moved = before.Keys.Union(after.Keys, StringComparer.Ordinal)
            .Where(formKey => !before.TryGetValue(formKey, out var was) || !after.TryGetValue(formKey, out var now) || was != now)
            .Union(statesBefore.Keys.Union(statesAfter.Keys, StringComparer.Ordinal)
                .Where(formKey => statesBefore.GetValueOrDefault(formKey) != statesAfter.GetValueOrDefault(formKey)),
                StringComparer.Ordinal);
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
        return modFolder != null && SourceRepository.HoldsTreeFor(modFolder, key.Name)
            ? sourceValidation.Validate(key, modFolder)
            : ValidateAgainstBinary(key);
    }

    /// <summary>Restates which truth <paramref name="key"/>'s rows read as, for Validate's tracked
    /// half.</summary>
    internal void RestampDerivation(PluginAddress key, DerivedFrom derivedFrom) =>
        _store.RestampDerivation(key, derivedFrom);

    internal void PublishRowsChanged(PluginAddress key, IReadOnlyList<string> formKeys) =>
        _store.Announce(() => _notifications?.Publish(new RowsChangedNotification(key, formKeys, Sequence)));

    // ADR-0003, asked of one plugin. A binary has no smaller unit, so a mismatch is a
    // rebuild the caller owns.
    private ValidationReport ValidateAgainstBinary(PluginAddress key)
    {
        // Nothing vouches for these rows (an in-memory mod, or a tracked plugin whose folder went
        // away), so there is nothing to compare them against.
        if (_store.IndexedFile(key) is not { } claim) return ValidationReport.Clean;

        if (!File.Exists(claim.FilePath))
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "{Plugin} ({Origin}) is absent from disk at {Path}; removing its rows",
                    key.Name, key.Origin, claim.FilePath);
            }
            Unindex(key);
            return ValidationReport.Clean;
        }

        // Reached only for a plugin no repository holds, so rows stamped from a source tree came from
        // one destroyed outside Modbench (ADR-0007), which the caller re-derives.
        if (_store.DerivationOf(key) == DerivedFrom.SourceTree)
            return new ValidationReport([], NeedsRebuild: true, []);

        return _store.FileContentHash(claim.FilePath) == claim.ContentHash
            ? ValidationReport.Clean
            : new ValidationReport([], NeedsRebuild: true, []);
    }

    // --- Queries ---

    private IRecordReads? _reads;

    // Empty until the Indexer points it somewhere: a store opened by a test that never reconciles
    // has no plugins open, which is what an empty set says.
    private Func<IReadOnlyDictionary<PluginAddress, PluginContent>> _openedPlugins =
        () => new Dictionary<PluginAddress, PluginContent>();

    public void ReadOpenedPluginsFrom(Func<IReadOnlyDictionary<PluginAddress, PluginContent>> opened) =>
        _openedPlugins = opened;

    /// <summary>See <see cref="IRecordIndex.Reads"/>.</summary>
    public IRecordReads Reads => _reads ??= new RelationReads(this);

    private sealed class RelationReads(DuckDbRecordIndex owner) : IRecordReads
    {
        public IReadOnlyDictionary<PluginAddress, PluginContent> OpenedPlugins => owner._openedPlugins();

        // A SELECT COUNT(*) always answers exactly one row with a non-null count.
        private static long ExecuteCount(DuckDBCommand cmd) =>
            (long)(cmd.ExecuteScalar() ?? throw new InvalidOperationException("Expected SELECT COUNT(*) to return a value."));

        public RecordDocument? GetDocument(string formKey)
        {
            using var connection = owner.OpenRead();
            owner.RequireSchemas(); // fails before any query runs, though OpenRead above has already opened the connection
            var tableName = FindRecordType(connection, formKey);
            return tableName == null ? null : owner.ReadDocument(connection, tableName, formKey, plugin: null, origin: null, winnerOnly: true);
        }

        public RecordDocument? GetDocument(string formKey, PluginAddress plugin)
        {
            using var connection = owner.OpenRead();
            owner.RequireSchemas();
            var tableName = FindRecordType(connection, formKey);
            return tableName == null ? null : owner.ReadDocument(connection, tableName, formKey, plugin.Name, plugin.Origin, winnerOnly: false);
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
                FROM records
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
            var tableName = FindRecordType(connection, formKey);
            if (tableName == null) return null;
            var schema = owner.RequireSchemas()[tableName];
            var resolve = LinkResolution.ForLinksOf(connection, formKey);
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, parse_diagnosis, working_tree_state
                FROM records
                WHERE form_key = $1 AND record_type = $2
                ORDER BY load_order_idx
                """;
            cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
            cmd.Parameters.Add(new DuckDBParameter { Value = NormalizeRecordType(tableName) });
            using var reader = cmd.ExecuteReader();

            var entries = new List<OverrideStackEntry>();
            while (reader.Read())
            {
                var doc = owner.ReadDocumentFromBody(reader, schema, resolve);
                var isDirty = WorkingTreeStates.FromStored(reader.GetString(8)) != WorkingTreeState.None;
                entries.Add(new OverrideStackEntry(doc.Plugin, doc.LoadOrderIndex, doc.IsWinner, doc, isDirty));
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
            var cols = $"""
                form_key, plugin, load_order_idx, is_winner, editor_id, origin, r.working_tree_state,
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
            countCmd.CommandText = $"SELECT COUNT(*) FROM records r{where}";
            AddParams(countCmd, paramValues);
            var total = ExecuteCount(countCmd);

            // xEdit's navigator lists a group in FormID order, and its record picker lists by EditorID.
            // (plugin, origin) makes either order total, so LIMIT/OFFSET pages stably.
            var order = query.GroupOnly ? NavigatorSql.FormIdOrder("form_key") : "editor_id, form_key";
            using var dataCmd = connection.CreateCommand();
            dataCmd.CommandText = $"""
                WITH RECURSIVE {NavigatorSql.AboveAFailure("records", holdings)}
                SELECT {cols} FROM records r{where}
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
                FROM records r{where}
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
        private static HashSet<string> TypesHoldingAFailure(DuckDBConnection connection, PluginAddress plugin)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                WITH RECURSIVE {NavigatorSql.AboveAFailure("records", "WHERE h.plugin = $1 AND h.origin = $2")}
                SELECT DISTINCT r.record_type FROM records r
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

        public Func<string, RecordLookupEntry?> LinkResolver(string formKey)
        {
            using var connection = owner.OpenRead();
            return LinkResolution.ForLinksOf(connection, formKey, Resolve);
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
            cmd.CommandText = $"SELECT DISTINCT plugin, origin FROM records{where}";
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
                $"SELECT DISTINCT form_key FROM records WHERE plugin = $1 AND origin = $2 AND record_type <> '{PluginHeader.RecordType}'";
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
                WITH RECURSIVE {NavigatorSql.AboveAFailure("records", "WHERE h.plugin = $1 AND h.origin = $2")}
                SELECT cl.cell_form_key, c.editor_id, cl.block_x, cl.block_y, cl.sub_x, cl.sub_y, cl.grid_x, cl.grid_y,
                       {FullNameOf("c")}, c.parse_diagnosis,
                       c.parse_diagnosis IS NOT NULL OR EXISTS (
                           SELECT 1 FROM above_failure a
                           WHERE a.form_key = cl.cell_form_key AND a.plugin = cl.plugin AND a.origin = cl.origin
                       ),
                       EXISTS (
                           SELECT 1 FROM ({NavigatorSql.CellChildren}) p
                           JOIN records pr ON pr.form_key = p.form_key AND pr.plugin = p.plugin AND pr.origin = p.origin
                           WHERE p.parent_cell = cl.cell_form_key AND p.plugin = cl.plugin AND p.origin = cl.origin
                             {InListingFilter("p")}
                       )
                FROM cell_location cl
                LEFT JOIN records c ON c.form_key = cl.cell_form_key AND c.plugin = cl.plugin AND c.origin = cl.origin
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

        public CellChildRecords GetCellChildRecords(PluginAddress plugin, string cellFormKey)
        {
            var schemas = owner.RequireSchemas();
            var cellChildTypes = CellChildTypeNames.Where(schemas.ContainsKey).ToList();
            if (cellChildTypes.Count == 0)
                return new CellChildRecords([], []);

            using var connection = owner.OpenRead();

            // ADR-0005: the placed ref's base form comes out of the document rather than a
            // `base` column; json_extract_string unquotes the stored FormLink text, and a placed ref
            // with no base reads NULL.
            var typeList = string.Join(", ", cellChildTypes.Select(t => $"'{t}'"));

            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                SELECT p.placement_group, r.record_type, p.form_key, r.editor_id,
                       json_extract_string(r.body, '$.Base'), r.parse_diagnosis IS NOT NULL, {FullNameOf("r")},
                       r.parse_diagnosis,
                       -- The base record's EditorID (plugins.md, Record). Its copy in the reference's own plugin, else the winning copy.
                       (SELECT b.editor_id FROM records b
                        WHERE b.form_key = json_extract_string(r.body, '$.Base')
                        ORDER BY (b.plugin = r.plugin AND b.origin = r.origin) DESC, b.is_winner DESC, b.plugin, b.origin
                        LIMIT 1)
                FROM ({NavigatorSql.CellChildren}) p
                JOIN records r ON r.form_key = p.form_key AND r.plugin = p.plugin AND r.origin = p.origin
                WHERE p.parent_cell = $1 AND p.plugin = $2 AND p.origin = $3
                  AND r.record_type IN ({typeList}){InListingFilter("p")}
                ORDER BY {NavigatorSql.FormIdOrder("p.form_key")}
                """;
            AddParams(cmd, [cellFormKey, plugin.Name, plugin.Origin]);
            using var reader = cmd.ExecuteReader();

            var persistent = new List<ChildRecordSummary>();
            var temporary = new List<ChildRecordSummary>();
            while (reader.Read())
            {
                var group = reader.GetString(0);
                var summary = new ChildRecordSummary(
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
            return new CellChildRecords(persistent, temporary);
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

        // Column 6 is the row's working_tree_state, 7 the correlated container_child EXISTS Search's
        // SELECT adds, 8 this record's own diagnosis, 9 the same fact widened to its children and 10
        // its FULL, read positionally.
        private static RecordSummary ReadSummary(DuckDBDataReader reader) =>
            new(reader.GetString(0), reader.GetString(1), LoadOrderSortKey(reader, 2),
                reader.GetBoolean(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetString(5),
                WorkingTreeStates.FromStored(reader.GetString(6)), reader.GetBoolean(7),
                reader.IsDBNull(8) ? null : reader.GetString(8), reader.GetBoolean(9),
                FullName: reader.IsDBNull(10) ? null : reader.GetString(10));

        private static string FullNameOf(string alias) =>
            $"NULLIF({TranslatedStringSql.Resolved($"{alias}.body", "$.Name")}, '')";

        // The callers hold ADR-0012, not this builder: RecordQueryService's
        // RecordFilterGuard refuses a plugin without its origin, and every other caller passes both
        // or neither.
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
        private static string? FindRecordType(DuckDBConnection connection, string formKey)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"SELECT record_type FROM records WHERE form_key = $1 LIMIT 1";
            cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
            return cmd.ExecuteScalar() as string;
        }

        private static List<ReferenceRow> GetReferences(DuckDBConnection connection, string targetFormKey)
        {
            // WorkingTreeOverlay keeps form_references rewritten as the working tree changes, so this
            // already sees every edit without applying anything itself.
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

        // ── Worldspace tree reads (plugins.md, The tree, story 6) ───────────────────

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

    private RecordDocument? ReadDocument(DuckDBConnection connection, string tableName, string formKey, string? plugin, string? origin, bool winnerOnly)
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
            FROM records WHERE {string.Join(" AND ", conditions)}
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
