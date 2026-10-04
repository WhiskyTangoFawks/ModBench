using System.Diagnostics;
using System.Globalization;
using DuckDB.NET.Data;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Index;

/// <summary>The connection/DDL/validate/rebuild collaborator of <see cref="DuckDbRecordIndex"/>.
/// Validate is a pure question: this class returns the stale set and never removes rows itself,
/// since <c>Unindex</c> is the caller's orchestrating verb.</summary>
internal sealed class Store : IDisposable
{
    internal const string FilesRelation = "mirror.files";
    internal const string PluginDerivationRelation = $"mirror.{TableDdlBuilder.PluginDerivationTable}";
    internal const string PluginDiagnosisRelation = $"mirror.{TableDdlBuilder.PluginDiagnosisTable}";
    internal const string SequenceRelation = "mirror.sequence";
    internal const string IndexVersionRelation = "mirror.index_version";

    private readonly ILogger _logger;
    private readonly string? _databasePath;
    private readonly TimeProvider _timeProvider;
    // One per Store.
    private readonly PluginFileHashes _hashes;

    public DuckDBConnection Connection { get; private set; }

    public Store(ILogger logger, string? databasePath, TimeProvider? timeProvider = null)
    {
        _logger = logger;
        _databasePath = databasePath;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _hashes = new PluginFileHashes(_timeProvider);
        Connection = Open();
    }

    // ADR-0010.
    private DuckDBConnection Open()
    {
        if (_databasePath == null)
        {
            var memory = new DuckDBConnection("DataSource=:memory:");
            memory.Open();
            return memory;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(_databasePath)
            ?? throw new InvalidOperationException($"Expected '{_databasePath}' to name a file in a folder."));
        try
        {
            return OpenFile();
        }
        catch (Exception ex) when (IsAnotherWriter(ex))
        {
            throw IndexHeldElsewhereException.For(_databasePath, ex);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // Every other exception, not DuckDBException alone: what an unreadable file throws has
            // changed between DuckDB versions, and the answer is the same for all of them.
            _logger.LogWarning(ex, "Could not open the index at {Path}; rebuilding it from scratch", _databasePath);
            File.Delete(_databasePath);
            return OpenFile();
        }
    }

    /// <summary>Whether the open failed because another process holds the file, which must never be
    /// answered by rebuilding: deleting an open file succeeds on POSIX and destroys a live index.
    /// Matched on DuckDB's message, all it offers.</summary>
    internal static bool IsAnotherWriter(Exception ex) =>
        ex.Message.Contains("lock on file", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("Conflicting lock", StringComparison.OrdinalIgnoreCase);

    // DuckDB.NET duplicates in-memory connections only; a file opened again on the same path shares
    // this process's database instance. Either way the read gets its own transaction context.
    public DuckDBConnection OpenReadConnection()
    {
        lock (_rebuildGate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            WaitWhile(() => _rebuilding, "being rebuilt");
            var connection = _databasePath == null ? Connection.Duplicate() : new DuckDBConnection($"DataSource={_databasePath}");
            connection.Open();
            _readsInFlight++;
            connection.Disposed += (_, _) => { lock (_rebuildGate) { _readsInFlight--; Monitor.PulseAll(_rebuildGate); } };
            return connection;
        }
    }

    // A reopen while a read connection is open gets DuckDB.NET's cached instance of the file the
    // rebuild just deleted, so a rebuild waits for reads in flight.
    private readonly object _rebuildGate = new();
    private int _readsInFlight;
    private bool _rebuilding;
    private bool _disposed;

    // Called under _rebuildGate. Bounded for the reason IndexWriteGate.HoldLimit gives: a read
    // connection that is never disposed would otherwise wedge every later rebuild and read behind
    // it, with nothing said.
    private void WaitWhile(Func<bool> pending, string what)
    {
        var deadline = _timeProvider.GetUtcNow() + IndexWriteGate.HoldLimit;
        while (pending())
        {
            var remaining = deadline - _timeProvider.GetUtcNow();
            if (remaining <= TimeSpan.Zero || !Monitor.Wait(_rebuildGate, remaining))
                throw new TimeoutException($"The index is still {what} after {IndexWriteGate.HoldLimit.TotalSeconds:0.###}s.");
        }
    }

    public void Dispose()
    {
        lock (_rebuildGate) _disposed = true;
        Connection.Dispose();
    }

    private DuckDBConnection OpenFile()
    {
        var connection = new DuckDBConnection($"DataSource={_databasePath}");
        connection.Open();
        return connection;
    }

    /// <summary>Discards a file written under another <see cref="IndexVersion"/> (whole-file rebuild,
    /// never partial), then creates the fixed tables and stamps the version they were built under.</summary>
    public void Initialize(string indexVersion)
    {
        DiscardFileWrittenUnderAnotherVersion(indexVersion);
        TableDdlBuilder.CreateTables(Connection);
        DuckDbSql.ExecuteFor(Connection, $"DELETE FROM {IndexVersionRelation}");
        DuckDbSql.ExecuteFor(Connection, $"INSERT INTO {IndexVersionRelation} (value) VALUES ($1)", indexVersion);
    }

    // ADR-0010, with no in-place migration.
    private void DiscardFileWrittenUnderAnotherVersion(string indexVersion)
    {
        if (_databasePath == null) return;

        string? written;
        try
        {
            // Asked of the catalog first so a never-written file (the ordinary first open) is an
            // answer, not an exception; past this point a file that cannot answer is stale.
            if (!IndexedFilesTableExists()) return;

            written = DuckDbSql.ScalarString(Connection, $"SELECT value FROM {IndexVersionRelation}");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex,
                "Could not read the index version at {Path}; rebuilding it from scratch", _databasePath);
            RebuildFile();
            return;
        }

        if (written == indexVersion) return;

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "The index at {Path} was written under a different codec/schema version; rebuilding it from scratch",
                _databasePath);
        }
        RebuildFile();
    }

    private bool IndexedFilesTableExists()
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText =
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'mirror' AND table_name = 'files'";
        return Convert.ToInt64(cmd.ExecuteScalar(), CultureInfo.InvariantCulture) > 0;
    }

    // Only reachable once the file has already been opened, so it can never race the second-writer
    // case IsAnotherWriter guards. Internal: ADR-0010's rebuild reuses this same
    // delete-and-reopen.
    internal void RebuildFile()
    {
        lock (_rebuildGate)
        {
            _rebuilding = true;
            try
            {
                WaitWhile(() => _readsInFlight > 0, "serving reads");
                Connection.Dispose();
                File.Delete(_databasePath
                    ?? throw new InvalidOperationException("An in-memory index has no file to rebuild."));
                Connection = OpenFile();
            }
            finally
            {
                _rebuilding = false;
                Monitor.PulseAll(_rebuildGate);
            }
        }
    }

    /// <summary>ADR-0003: the indexed plugins whose file is gone or differs from its hash, for the
    /// caller to unindex.</summary>
    public List<PluginAddress> ValidateAgainstDisk()
    {
        var stale = new List<PluginAddress>();
        if (_databasePath == null) return stale;

        var timer = Stopwatch.StartNew();
        var checkedCount = 0;
        foreach (var (key, filePath, contentHash) in IndexedFiles())
        {
            checkedCount++;
            if (!File.Exists(filePath))
            {
                if (_logger.IsEnabled(LogLevel.Information))
                {
                    _logger.LogInformation(
                        "{Plugin} ({Origin}) is absent from disk at {Path}; removing its rows",
                        key.Name, key.Origin, filePath);
                }
                stale.Add(key);
                continue;
            }

            if (FileContentHash(filePath) is not { } observed || observed != contentHash)
            {
                if (_logger.IsEnabled(LogLevel.Information))
                {
                    _logger.LogInformation(
                        "{Plugin} ({Origin}) changed on disk since it was indexed; removing its rows so it is re-indexed",
                        key.Name, key.Origin);
                }
                stale.Add(key);
            }
        }

        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Validated {Count} indexed plugin(s) against disk in {ElapsedMs} ms",
                checkedCount, timer.ElapsedMilliseconds);
        }

        return stale;
    }

    private List<(PluginAddress Key, string FilePath, string ContentHash)> IndexedFiles()
    {
        var rows = new List<(PluginAddress Key, string FilePath, string ContentHash)>();
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT plugin, origin, file_path, content_hash FROM {FilesRelation}";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            rows.Add((new PluginAddress(reader.GetString(0), reader.GetString(1)), reader.GetString(2), reader.GetString(3)));
        return rows;
    }

    // Null when the file cannot be read (mid-write, permissions) counts as a mismatch: an unreadable
    // file is no evidence its rows are still true. Shared with PluginBinaryHash so identical bytes
    // hash identically.
    internal string? FileContentHash(string filePath)
    {
        var hash = _hashes.Of(filePath);
        if (hash == null) LogUnreadable(filePath);
        return hash;
    }

    private void LogUnreadable(string filePath)
    {
        if (_logger.IsEnabled(LogLevel.Warning))
            _logger.LogWarning("Could not read {Path} to hash it; treating the index's rows for it as stale", filePath);
    }

    /// <summary>The disk claim <paramref name="key"/>'s rows carry, or null when nothing backs them.
    /// Validate's untracked half asks for both halves at once: the path to re-hash and the hash the
    /// rows were built under.</summary>
    internal (string FilePath, string ContentHash)? IndexedFile(PluginAddress key)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT file_path, content_hash FROM {FilesRelation} WHERE plugin = $1 AND origin = $2";
        DuckDbSql.AddParams(cmd, [key.Name, key.Origin]);
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? (reader.GetString(0), reader.GetString(1)) : null;
    }

    /// <summary>Which truth <paramref name="key"/>'s rows were derived from, or null when the store
    /// holds no rows for it.</summary>
    internal DerivedFrom? DerivationOf(PluginAddress key) =>
        DuckDbSql.ScalarString(Connection,
            $"SELECT derived_from FROM {PluginDerivationRelation} WHERE plugin = $1 AND origin = $2",
            key.Name, key.Origin) is { } stamp && Enum.TryParse<DerivedFrom>(stamp, out var derivedFrom)
            ? derivedFrom
            : null;

    /// <summary>Restates which truth <paramref name="key"/>'s rows read as, leaving the file claim
    /// beside it: a refresh re-derives the rows in place, and the binary they were stamped against
    /// is still the file on disk.</summary>
    internal void RestampDerivation(PluginAddress key, DerivedFrom derivedFrom) =>
        DuckDbSql.ExecuteFor(Connection,
            $"UPDATE {PluginDerivationRelation} SET derived_from = $1 WHERE plugin = $2 AND origin = $3",
            derivedFrom.ToString(), key.Name, key.Origin);

    /// <summary>See <see cref="IRecordIndex.IndexedContentHash"/>.</summary>
    public string? IndexedContentHash(PluginAddress key)
    {
        using var connection = OpenReadConnection();
        return DuckDbSql.ScalarString(connection,
            $"SELECT content_hash FROM {FilesRelation} WHERE plugin = $1 AND origin = $2",
            key.Name, key.Origin);
    }

    // The plugin half of an Index() call, inside its transaction. A caller
    // naming no file (an in-memory mod) writes no file row, so nothing vouches for those rows and
    // the next load re-indexes.
    public void StampPluginFacts(string plugin, string origin, string? filePath, DerivedFrom derivedFrom)
    {
        DeletePluginFacts(plugin, origin);
        DuckDbSql.ExecuteFor(Connection, $"""
            INSERT INTO {PluginDerivationRelation} (plugin, origin, derived_from) VALUES ($1, $2, $3)
            """, plugin, origin, derivedFrom.ToString());
        if (filePath == null || PluginBinaryHash.BytesOfFile(filePath) is not { } bytes)
        {
            if (filePath != null) LogUnreadable(filePath);
            return;
        }

        DuckDbSql.ExecuteFor(Connection, $"""
            INSERT INTO {FilesRelation} (plugin, origin, file_path, content_hash)
            VALUES ($1, $2, $3, $4)
            """, plugin, origin, Path.GetFullPath(filePath), PluginBinaryHash.OfBytes(bytes));
        StampDiagnoses(plugin, origin, bytes);
    }

    // The bytes are in hand for the hash, so the Kind B scan reads them here rather than the file
    // again. A scan that throws is logged and leaves no rows, never a refused ingest.
    private void StampDiagnoses(string plugin, string origin, byte[] bytes)
    {
        List<PluginDiagnosis> diagnoses;
        try
        {
            diagnoses = MalformedPluginScan.Scan(bytes);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            _logger.LogWarning(ex, "Could not scan {Plugin} ({Origin}) for malformed records", plugin, origin);
            return;
        }

        for (var ordinal = 0; ordinal < diagnoses.Count; ordinal++)
        {
            var d = diagnoses[ordinal];
            using var cmd = Connection.CreateCommand();
            cmd.CommandText = $"""
                INSERT INTO {PluginDiagnosisRelation} (plugin, origin, ordinal, anchor, defect_class, tail, message)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                """;
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
            cmd.Parameters.Add(new DuckDBParameter { Value = origin });
            cmd.Parameters.Add(new DuckDBParameter { Value = ordinal });
            cmd.Parameters.Add(new DuckDBParameter { Value = (object?)d.Anchor ?? DBNull.Value });
            cmd.Parameters.Add(new DuckDBParameter { Value = d.DefectClass });
            cmd.Parameters.Add(new DuckDBParameter { Value = (object?)d.Tail ?? DBNull.Value });
            cmd.Parameters.Add(new DuckDBParameter { Value = d.Message });
            cmd.ExecuteNonQuery();
        }
    }

    /// <summary>The file claim, the derivation and the diagnoses go together: every one of them is
    /// about the rows this plugin holds, and Unindex is the verb that drops those.</summary>
    public void DeletePluginFacts(string plugin, string origin)
    {
        DuckDbSql.ExecuteFor(Connection, $"DELETE FROM {FilesRelation} WHERE plugin = $1 AND origin = $2", plugin, origin);
        DuckDbSql.ExecuteFor(Connection, $"DELETE FROM {PluginDerivationRelation} WHERE plugin = $1 AND origin = $2", plugin, origin);
        DuckDbSql.ExecuteFor(Connection, $"DELETE FROM {PluginDiagnosisRelation} WHERE plugin = $1 AND origin = $2", plugin, origin);
    }

    // ADR-0015: one advance per logical projection, not per transaction inside it. A whole-plugin
    // ingest is four transactions, so a client awaiting the sequence once could otherwise read an
    // in-between state.
    private readonly Lock _projectionLock = new();

    // Per projection, never store-wide: a source batch and a reconcile hold different gates, so a
    // shared counter would let one swallow the other's advance. Flow-local, so nesting is seen and
    // concurrency is not.
    private readonly AsyncLocal<ProjectionScope?> _openProjection = new();

    internal IDisposable BeginProjection()
    {
        var scope = new ProjectionScope(EndProjection, _openProjection.Value);
        _openProjection.Value = scope;
        return scope;
    }

    // Outside a scope this joins whichever transaction is active on Connection, so the caller's
    // commit or rollback decides the counter's fate with the rows. Inside one the advance is
    // deferred instead, landing after the last of those commits.
    public void BumpSequence()
    {
        if (_openProjection.Value is { } scope)
        {
            lock (_projectionLock) scope.BumpOwed = true;
            return;
        }
        Advance();
    }

    /// <summary>Runs <paramref name="publish"/> once the projection has landed: immediately outside
    /// a scope, after the advance inside one. A subscriber is never told about rows at a sequence
    /// the store has not reached.</summary>
    internal void Announce(Action publish)
    {
        if (_openProjection.Value is { } scope)
        {
            lock (_projectionLock) scope.Announcements.Add(publish);
            return;
        }
        publish();
    }

    private void Advance() =>
        DuckDbSql.ExecuteFor(Connection, $"UPDATE {SequenceRelation} SET value = value + 1");

    // A transaction that rolled back inside the scope still leaves the advance owed, so this can
    // over-signal — a re-read finding nothing changed — but never under-signal.

    // The advance runs before the debt is cleared and before a single notification goes out, so a
    // failed UPDATE throws with both still owed rather than losing them silently.
    private void EndProjection(ProjectionScope scope)
    {
        _openProjection.Value = scope.Parent;

        List<Action> announcements;
        lock (_projectionLock)
        {
            // Nested: the debt and the announcements are the enclosing projection's, so a batch
            // stays one advance however many whole-plugin projections it contains.
            if (scope.Parent is { } parent)
            {
                parent.BumpOwed |= scope.BumpOwed;
                parent.Announcements.AddRange(scope.Announcements);
                scope.Announcements.Clear();
                return;
            }

            if (scope.BumpOwed)
            {
                Advance();
                scope.BumpOwed = false;
            }
            announcements = [.. scope.Announcements];
            scope.Announcements.Clear();
        }

        foreach (var publish in announcements) publish();
    }

    // Calls back into the store to end the scope rather than holding the store itself: the scope
    // does not own the store's lifetime, so a disposable-typed field here would claim it does.
    private sealed class ProjectionScope(Action<ProjectionScope> endProjection, ProjectionScope? parent) : IDisposable
    {
        internal ProjectionScope? Parent { get; } = parent;
        internal bool BumpOwed { get; set; }
        internal List<Action> Announcements { get; } = [];
        private Action<ProjectionScope>? _endProjection = endProjection;

        // Idempotent: a second Dispose would otherwise re-announce and pop a scope it does not own.
        public void Dispose() => Interlocked.Exchange(ref _endProjection, null)?.Invoke(this);
    }

    public long CurrentSequence()
    {
        using var connection = OpenReadConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT value FROM {SequenceRelation}";
        return Convert.ToInt64(cmd.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    // ADR-0015: raises the sequence to at least atLeast, never lowers it — Sequence
    // must never regress within one process across a rebuild.
    internal void SeedSequence(long atLeast)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"UPDATE {SequenceRelation} SET value = $1 WHERE value < $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = atLeast });
        cmd.Parameters.Add(new DuckDBParameter { Value = atLeast });
        cmd.ExecuteNonQuery();
    }
}
