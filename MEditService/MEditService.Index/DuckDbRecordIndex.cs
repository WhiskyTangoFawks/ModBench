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

// The single DuckDB implementation of IRecordIndex, over a Store that answers the reads, split into four collaborators:
// Store, PluginIngest, WorkingTreeOverlay and SourceValidation. This class owns every
// transaction boundary, registration and the winner sweep.
internal sealed class DuckDbRecordIndex : IRecordIndex
{
    private readonly SchemaReflector _schemaReflector;
    private readonly ILogger _logger;

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
        _logger = logger;
        _notifications = notifications;
        _store = new Store(logger, databasePath, schemaReflector, ddlBuilder, timeProvider);
    }

    public string? HeldElsewhere { get; private set; }

    public void Open() => HeldElsewhere = _store.Open();

    // Reading a record back out of its document needs the release it was written under, and this
    // repository is one game for its whole lifetime — the same reasoning that resolves the schemas
    // once, here.
    private GameRelease _release;

    public void Initialize(GameRelease release)
    {
        // Store's own version check throws away a file written under a different shape *before*
        // this process starts appending to tables it only half recognizes.
        _store.Initialize(release);

        var schemas = _store.Schemas;
        _release = release;

        var containers = new ContainerDocuments(release, schemas);
        _pluginIngest = new PluginIngest(Connection, _logger, containers);
        _workingTreeOverlay = new WorkingTreeOverlay(Connection, _logger, _codec, containers, schemas, release);
        _sourceValidation = new SourceValidation(this, Connection, release, _logger);

        // Unindex is this class's cross-cutting verb (registration plus every ingest-owned table), so
        // acting on the stale set stays here.
        foreach (var key in _store.ValidateAgainstDisk())
            Unindex(key);
    }

    // ADR-0010: the rebuild's whole job on an already-opened index — the open
    // already refused if another process held the file, so nothing
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
        var schemas = _store.Schemas;

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
            Value = _store.OpenedPlugins().TryGetValue(new PluginAddress(plugin, origin), out var content) && content.IsLight,
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

    // One transaction for the batch, so a throw partway leaves no row half-projected. A null body is
    // the document gone. Returns every key whose rows moved, embedded children included.
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

        var learned = changes.ToDictionary(
            change => change.Key,
            change => change.Value == RecordChange.Added ? WorkingTreeState.Added : WorkingTreeState.Modified,
            StringComparer.Ordinal);
        var moved = KeysDiffering(HeldWorkingTreeStates(key), learned)
            .Select(formKey => (FormKey: formKey, State: learned.GetValueOrDefault(formKey)))
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

    // A key absent from one side reads as that value's default: a clean row, or no row.
    private static IEnumerable<string> KeysDiffering<T>(
        IReadOnlyDictionary<string, T> before, IReadOnlyDictionary<string, T> after) =>
        before.Keys.Union(after.Keys, StringComparer.Ordinal)
            .Where(formKey => !EqualityComparer<T>.Default.Equals(
                before.GetValueOrDefault(formKey), after.GetValueOrDefault(formKey)));

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
        // One signal, one advance, however many documents it moves.
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

        // Ingest and winner sweep are one whole-plugin projection, so they are one
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
        var moved = KeysDiffering(before, after).Union(KeysDiffering(statesBefore, statesAfter), StringComparer.Ordinal);
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

    public void ReadOpenedPluginsFrom(Func<IReadOnlyDictionary<PluginAddress, PluginContent>> opened) =>
        _store.ReadOpenedPluginsFrom(opened);

    /// <summary>See <see cref="IRecordIndex.Reads"/>.</summary>
    public IRecordReads Reads => _store.Reads;

    public void SetFilter(string? sql) => _store.Filter.Set(sql);

    private void Execute(string sql)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    public void Dispose() => _store.Dispose();
}
