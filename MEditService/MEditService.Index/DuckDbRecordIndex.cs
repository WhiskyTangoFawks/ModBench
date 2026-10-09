using System.Data;
using System.Diagnostics;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Index;

// The Store's write verbs: every transaction boundary, registration and the winner sweep.
internal sealed class DuckDbRecordIndex : IDisposable
{
    private readonly ILogger _logger;

    // Constructed rather than injected: it is stateless apart from static reflection caches, and
    // every construction site would otherwise learn a dependency it has no say in.

    private readonly Store _store;
    private readonly IndexWriteGate _gate;
    private readonly FilterInForce _filter;
    private readonly INotificationPublisher? _notifications;
    private readonly Projection _projection;
    private readonly PluginIngest _pluginIngest;
    private readonly WorkingTreeOverlay _workingTreeOverlay;

    private DuckDBConnection Connection => _store.Connection;
    private DuckDBConnection OpenRead() => _store.OpenReadConnection();

    /// <summary>Over a store whose tables <see cref="Store.Initialize"/> has created. Unindexes
    /// what the file holds that disagrees with the disk (ADR-0003). The gate and the filter outlive
    /// the store: a rebuild swaps the store beneath them.</summary>
    public DuckDbRecordIndex(
        Store store, IndexWriteGate gate, FilterInForce filter, INotificationPublisher? notifications, ILogger logger)
    {
        _store = store;
        _gate = gate;
        _filter = filter;
        _notifications = notifications;
        _logger = logger;
        _projection = new Projection(this);

        _pluginIngest = new PluginIngest(Connection, logger, store.Release);
        _workingTreeOverlay = new WorkingTreeOverlay(Connection, logger, store.Schemas, store.Release);

        Commit(_ =>
        {
            foreach (var key in store.ValidateAgainstDisk())
                Unindex(key);
        });
    }

    /// <summary>The one way the rows change (ADR-0015). Once the outermost commit's writes are in,
    /// thrown or not, a sweep included: the winner sweep they owe, the filter again, one advance,
    /// then their announcements.</summary>
    public T Commit<T>(Func<Projection, T> write)
    {
        using var held = _gate.Enter();
        using var scope = _store.BeginProjection();
        try
        {
            return write(_projection);
        }
        finally
        {
            if (scope.Parent is null) Land(scope.SweepOwed);
        }
    }

    public void Commit(Action<Projection> write) => Commit(projection =>
    {
        write(projection);
        return true;
    });

    private void Land(bool sweepOwed)
    {
        try
        {
            if (sweepOwed) SweepWinners();
        }
        finally
        {
            _filter.Reapply(this);
        }
    }

    /// <summary>What one commit owes beyond its rows.</summary>
    internal sealed class Projection(DuckDbRecordIndex index)
    {
        /// <summary>Owed by rows that moved which record wins a FormKey; the outermost commit sweeps
        /// once for all of them.</summary>
        public void OweWinnerSweep() => index._store.OweWinnerSweep();

        public void Announce(Func<long, INotification> announcement) =>
            index._store.Announce(() => index._notifications?.Publish(announcement(index.Sequence)));

        /// <summary>ADR-0015: a whole plugin re-derived or removed has too many rows to name, and can
        /// move the winner of every FormKey it holds.</summary>
        public void PluginChanged(PluginAddress key)
        {
            OweWinnerSweep();
            Announce(sequence => new PluginChangedNotification(key, sequence));
        }

        /// <summary>A plugin whose read failed or recovered while its rows stood: no row moved, but what
        /// the plugin says of them did.</summary>
        public void ReadChanged(PluginAddress key) => Announce(sequence => new PluginChangedNotification(key, sequence));
    }

    public GameRelease Release => _store.Release;

    public IReadOnlyDictionary<string, RecordTableSchema> Schemas => _store.Schemas;

    // --- Indexing ---

    /// <summary>The hash of the file <paramref name="key"/>'s rows were built from, or null when the
    /// index holds no validated rows for it. Independent of registration, so a returning profile
    /// switch is cheap (ADR-0012).</summary>
    public string? IndexedContentHash(PluginAddress key) => _store.IndexedContentHash(key);

    /// <summary>The hash of the file at <paramref name="path"/> now (ADR-0003). Null when the file
    /// cannot be read.</summary>
    public string? FileContentHash(string path) => _store.FileContentHash(path);

    /// <summary>ADR-0015: one monotonic counter, advanced in the same transaction as any row change.
    /// Zero until the first change lands.</summary>
    public long Sequence => _store.CurrentSequence();

    /// <summary>Indexes one plugin's documents, replacing whatever the key held. Stamps the file's
    /// hash and diagnosis (ADR-0003); a null path claims no file backs the rows (ADR-0012).</summary>
    public void Index(IPluginDocuments documents, PluginMetadata registered, string? filePath, DerivedFrom derivedFrom)
    {
        var (plugin, origin) = (registered.Name, registered.Origin);
        var schemas = _store.Schemas;

        // One transaction for the whole reindex so a throw partway leaves the read model intact
        // rather than a partial snapshot.
        using var tx = Connection.BeginTransaction();

        // The `registrations` row lands in the same transaction as the rows, which answer nothing
        // without it.
        UpsertRegistration(registered);
        // And the facts about these rows — the disk claim, the derivation, the diagnosis — replaced
        // with them rather than beside them.
        _store.StampPluginFacts(plugin, origin, filePath, derivedFrom);

        var timing = _pluginIngest.IndexPlugin(documents, plugin, origin, schemas);
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

    /// <summary>ADR-0012's file-gone verb: every trace of <paramref name="key"/> removed, rows and
    /// registration alike, the winners they held swept and the plugin announced. Leaving the load
    /// order is <see cref="Unregister"/>.</summary>
    public void Unindex(PluginAddress key) => Commit(projection =>
    {
        DeleteEveryTraceOf(key.Name, key.Origin);
        projection.PluginChanged(key);
    });

    // The `registrations` row is dropped last: while it exists this (origin, plugin) is still a
    // known member of the read model, so no read can meet rows that have already gone.
    private void DeleteEveryTraceOf(string plugin, string origin)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Unindexing {Plugin} from {Origin}", plugin, origin);
        }
        using var tx = Connection.BeginTransaction();

        _pluginIngest.DeleteAllRowsFor(plugin, origin);
        // The plugin's facts go with the rows they describe — Unindex is the file-gone verb, so
        // leaving them behind would leave the files table asserting rows the index does not hold.
        _store.DeletePluginFacts(plugin, origin);
        DeleteRegistration(plugin, origin);
        _store.BumpSequence();

        tx.Commit();
    }

    // ADR-0013: one row per registered plugin, carrying its load index.
    private void UpsertRegistration(PluginMetadata registered)
    {
        DeleteRegistration(registered.Name, registered.Origin);
        using var cmd = Connection.CreateCommand();
        cmd.CommandText =
            $"INSERT INTO {TableDdlBuilder.RegistrationsRelation} (plugin, origin, load_order_idx, is_light) VALUES ($1, $2, $3, $4)";
        cmd.Parameters.Add(new DuckDBParameter { Value = registered.Name });
        cmd.Parameters.Add(new DuckDBParameter { Value = registered.Origin });
        cmd.Parameters.Add(new DuckDBParameter
        {
            Value = registered.LoadOrderIndex is { } loadOrderIndex ? (object)loadOrderIndex : DBNull.Value,
        });
        cmd.Parameters.Add(new DuckDBParameter { Value = registered.IsLight });
        cmd.ExecuteNonQuery();
    }

    /// <summary>Upserts the plugin's <c>registrations</c> row: its indexed facts answer with no re-index
    /// (ADR-0012). Winners stay stale until the next sweep.</summary>
    public void Register(PluginMetadata registered)
    {
        using var tx = Connection.BeginTransaction();
        Respell(registered.Key, registered.Path);
        UpsertRegistration(registered);
        _store.BumpSequence();
        tx.Commit();
    }

    // Every table compares plugin names without case, so rows spelled before a case-only change still
    // belong to the plugin; they are renamed to the file's spelling now, with no re-read.
    private void Respell(PluginAddress now, string path)
    {
        using (var cmd = Connection.CreateCommand())
        {
            cmd.CommandText = $"SELECT plugin, origin FROM {TableDdlBuilder.RegistrationsRelation} WHERE plugin = $1 AND origin = $2";
            cmd.Parameters.Add(new DuckDBParameter { Value = now.Name });
            cmd.Parameters.Add(new DuckDBParameter { Value = now.Origin });
            using var reader = cmd.ExecuteReader();
            if (!reader.Read() || new PluginAddress(reader.GetString(0), reader.GetString(1)) == now) return;
        }

        foreach (var (relation, pluginColumn, originColumn) in TableDdlBuilder.MirroredPluginNames)
        {
            DuckDbSql.ExecuteFor(Connection, $"""
                UPDATE {relation} SET {pluginColumn} = $1, {originColumn} = $2
                WHERE {pluginColumn} = $1 AND {originColumn} = $2
                """, now.Name, now.Origin);
        }
        _store.PointFileClaimAt(now, path);
    }

    /// <summary>Removes <paramref name="key"/>'s <c>registrations</c> row and nothing else: its rows
    /// remain and answer nothing. Winner state is stale until the next sweep.</summary>
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

    /// <summary>ADR-0013: every plugin the index currently registers: what a reconcile diffs the
    /// incoming snapshot against, since a freshly opened file still carries the last run's
    /// registrations.</summary>
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
    private void SweepWinners()
    {
        var timer = Stopwatch.StartNew();
        using (var tx = Connection.BeginTransaction())
        {
            UpdateWinnersCore();
            _store.BumpSequence();
            tx.Commit();
        }
        if (_logger.IsEnabled(LogLevel.Debug))
            _logger.LogDebug("Swept winners in {ElapsedMs} ms", timer.ElapsedMilliseconds);
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

    private const string EffectiveRows = $"{TableDdlBuilder.MirrorSchema}.records";

    // One transaction for the batch, so a throw partway leaves no row half-projected. A null body is
    // the document gone. Returns every key whose rows moved, embedded children included.
    public List<string> ProjectDocuments(PluginAddress key, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        if (deltas.Count == 0) return [];

        using var tx = Connection.BeginTransaction();
        var projected = _workingTreeOverlay.ProjectDocuments(key, deltas);
        _store.BumpSequence();
        tx.Commit();
        // Only a delta that added or removed a row can move winner status. Re-swept for the whole
        // load order rather than per FormKey because UpdateWinners is the one definition of winning
        // (measured at 18 ms over 48k records).
        if (projected.Structural) _projection.OweWinnerSweep();
        return projected.Touched;
    }

    /// <summary>Sets each listed row to the state it is now in (ADR-0007), in one advance.</summary>
    public void SetWorkingTreeStates(PluginAddress key, IReadOnlyList<(string FormKey, WorkingTreeState State)> moved)
    {
        using var tx = Connection.BeginTransaction();
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

    public Dictionary<string, WorkingTreeState> HeldWorkingTreeStates(PluginAddress key)
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

    // --- What the rows hold ---

    // The projection reads the plugin's rows whether it is active or not (ADR-0012).
    public (string RecordType, string? EditorId, string Body)? StoredRow(PluginAddress key, string formKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT record_type, editor_id, body FROM {EffectiveRows} WHERE form_key = $1 AND plugin = $2 AND origin = $3";
        DuckDbSql.AddParams(cmd, [formKey, key.Name, key.Origin]);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;
        return (reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1), reader.GetString(2));
    }

    public Dictionary<string, string> EffectiveContentHashes(PluginAddress key)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT form_key, content_hash FROM {EffectiveRows} WHERE plugin = $1 AND origin = $2";
        DuckDbSql.AddParams(cmd, [key.Name, key.Origin]);
        using var reader = cmd.ExecuteReader();
        var hashes = new Dictionary<string, string>(StringComparer.Ordinal);
        while (reader.Read()) hashes[reader.GetString(0)] = reader.GetString(1);
        return hashes;
    }

    // One row per source document: every Effective record no document embeds. A worldspace's TopCell
    // is embedded, and its null block coordinates tell it from an exterior cell, which has a directory.
    private const string DocumentStamps = """
        SELECT r.form_key, r.content_hash
        FROM mirror.records r
        WHERE r.plugin = $1 AND r.origin = $2
          AND NOT EXISTS (
            SELECT 1 FROM mirror.container_child c
            WHERE c.child_form_key = r.form_key AND c.plugin = r.plugin AND c.origin = r.origin)
          AND NOT EXISTS (
            SELECT 1 FROM mirror.placement p
            WHERE p.form_key = r.form_key AND p.plugin = r.plugin AND p.origin = r.origin)
          AND NOT EXISTS (
            SELECT 1 FROM mirror.cell_location l
            WHERE l.cell_form_key = r.form_key AND l.plugin = r.plugin AND l.origin = r.origin
              AND l.parent_worldspace IS NOT NULL AND l.block_x IS NULL)
        """;

    /// <summary>The content stamp of each source document the rows were derived from, by the key of
    /// the record it files.</summary>
    public Dictionary<string, string> HeldDocumentStamps(PluginAddress key)
    {
        var stamps = new Dictionary<string, string>(StringComparer.Ordinal);
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = DocumentStamps;
        DuckDbSql.AddParams(cmd, [key.Name, key.Origin]);
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            stamps[reader.GetString(0)] = reader.GetString(1);
        return stamps;
    }

    /// <summary>The disk claim <paramref name="key"/>'s rows carry, or null when nothing backs them.</summary>
    public (string FilePath, string ContentHash)? IndexedFile(PluginAddress key) => _store.IndexedFile(key);

    /// <summary>Which truth <paramref name="key"/>'s rows were derived from, or null when the store
    /// holds no rows for it.</summary>
    public DerivedFrom? DerivationOf(PluginAddress key) => _store.DerivationOf(key);

    /// <summary>Restates which truth <paramref name="key"/>'s rows read as, leaving the file claim
    /// beside it.</summary>
    public void RestampDerivation(PluginAddress key, DerivedFrom derivedFrom) =>
        _store.RestampDerivation(key, derivedFrom);

    // --- Queries ---

    /// <summary>Every read the index answers.</summary>
    public IRecordReads Reads => _store.Reads;

    /// <summary>Materializes <paramref name="sql"/>'s matches and the records holding them (null
    /// clears both), the one door SQL crosses. Throws if the SQL returns no <c>form_key</c>
    /// column.</summary>
    public void SetFilter(string? sql) => _store.Filter.Set(sql);

    private void Execute(string sql)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    /// <inheritdoc cref="Store.EndReads"/>
    public bool EndReads() => _store.EndReads();

    public void Dispose() => _store.Dispose();
}
