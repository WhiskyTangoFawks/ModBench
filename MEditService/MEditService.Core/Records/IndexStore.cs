using System.Diagnostics;
using System.Globalization;
using DuckDB.NET.Data;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

/// <summary>The connection/DDL/validate/rebuild collaborator of <see cref="DuckDbRecordIndex"/>.
/// Validate is a pure question: this class returns the stale set and never removes rows itself,
/// since <c>Unindex</c> is the caller's orchestrating verb.</summary>
internal sealed class IndexStore
{
    private const string FilesRelation = "mirror.files";
    private const string SequenceRelation = "mirror.sequence";

    private readonly ILogger _logger;
    private readonly string? _databasePath;

    // The version the rows in this file were written under (IndexVersion), resolved once at
    // Initialize once the game release is known — same "one game for its whole lifetime" reasoning
    // DuckDbRecordIndex itself already applies to _release.
    private string? _indexVersion;

    public DuckDBConnection Connection { get; private set; }

    public IndexStore(ILogger logger, string? databasePath)
    {
        _logger = logger;
        _databasePath = databasePath;
        Connection = Open();
    }

    // Rebuilds from scratch if the file cannot be opened at all (ADR-0001 point 6): the index is
    // derived state and losing it costs one cold load, so a rebuild beats refusing to start.
    private DuckDBConnection Open()
    {
        if (_databasePath == null)
        {
            var memory = new DuckDBConnection("DataSource=:memory:");
            memory.Open();
            return memory;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(_databasePath)!);
        try
        {
            return OpenFile();
        }
        catch (Exception ex) when (IsAnotherWriter(ex))
        {
            throw IndexHeldElsewhereException.For(_databasePath, ex);
        }
        catch (Exception ex)
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

    private DuckDBConnection OpenFile()
    {
        var connection = new DuckDBConnection($"DataSource={_databasePath}");
        connection.Open();
        return connection;
    }

    /// <summary>Discards a file written under another <see cref="IndexVersion"/> (whole-file rebuild,
    /// never partial), then creates the fixed tables.</summary>
    public void Initialize(string indexVersion)
    {
        _indexVersion = indexVersion;
        DiscardFileWrittenUnderAnotherVersion();
        TableDdlBuilder.CreateTables(Connection);
    }

    // ADR-0001: a codec or schema version change invalidates the whole file, and there is no
    // in-place migration: the file is deleted and reopened empty, costing one cold load.
    private void DiscardFileWrittenUnderAnotherVersion()
    {
        if (_databasePath == null) return;

        List<string> versions;
        try
        {
            // Asked of the catalog first so a never-written file (the ordinary first open) is an
            // answer, not an exception; past this point a file that cannot answer is stale.
            if (!IndexedFilesTableExists()) return;

            versions = [];
            using var cmd = Connection.CreateCommand();
            cmd.CommandText = $"SELECT DISTINCT index_version FROM {FilesRelation}";
            using var reader = cmd.ExecuteReader();
            while (reader.Read()) versions.Add(reader.GetString(0));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex,
                "Could not read the index version at {Path}; rebuilding it from scratch", _databasePath);
            RebuildFile();
            return;
        }

        if (versions.Count == 0 || versions.All(v => v == _indexVersion)) return;

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
    // case IsAnotherWriter guards. Internal: ADR-0046's rebuild reuses this same delete-and-reopen.
    internal void RebuildFile()
    {
        Connection.Dispose();
        File.Delete(_databasePath!);
        Connection = OpenFile();
    }

    /// <summary>ADR-0001: validity is by content, never by clock: a hash, not mtime, since MO2, xEdit
    /// and the user all write these files. Registrations are not cleared (ADR-0044); the first
    /// reconcile corrects them.</summary>
    public List<PluginKey> ValidateAgainstDisk()
    {
        var stale = new List<PluginKey>();
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

    private List<(PluginKey Key, string FilePath, string ContentHash)> IndexedFiles()
    {
        var rows = new List<(PluginKey Key, string FilePath, string ContentHash)>();
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT plugin, origin, file_path, content_hash FROM {FilesRelation}";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            rows.Add((new PluginKey(reader.GetString(0), reader.GetString(1)), reader.GetString(2), reader.GetString(3)));
        return rows;
    }

    // Null when the file cannot be read (mid-write, permissions) counts as a mismatch: an unreadable
    // file is no evidence its rows are still true. Shared with PluginBinaryHash so identical bytes
    // hash identically.
    private string? FileContentHash(string filePath)
    {
        var hash = PluginBinaryHash.OfFile(filePath);
        if (hash == null && _logger.IsEnabled(LogLevel.Warning))
        {
            _logger.LogWarning("Could not read {Path} to hash it; treating the index's rows for it as stale", filePath);
        }
        return hash;
    }

    /// <summary>The disk claim <paramref name="key"/>'s rows carry, or null when nothing backs them.
    /// Validate's untracked half asks for both halves at once: the path to re-hash and the hash the
    /// rows were built under.</summary>
    internal (string FilePath, string ContentHash)? IndexedFile(PluginKey key)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT file_path, content_hash FROM {FilesRelation} WHERE plugin = $1 AND origin = $2";
        DuckDbSql.AddParams(cmd, [key.Name, key.Origin!]);
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? (reader.GetString(0), reader.GetString(1)) : null;
    }

    /// <summary>See <see cref="IRecordIndex.IndexedContentHash"/>.</summary>
    public string? IndexedContentHash(PluginKey key) =>
        DuckDbSql.ScalarString(Connection,
            $"SELECT content_hash FROM {FilesRelation} WHERE plugin = $1 AND origin = $2",
            key.Name, key.Origin!);

    // ADR-0001: the file half of an Index() call, inside its transaction. A caller naming no file
    // (an in-memory mod) writes no row, so nothing vouches for those rows and the next load
    // re-indexes.
    public void StampIndexedFile(string plugin, string origin, string? filePath)
    {
        DeleteIndexedFile(plugin, origin);
        if (filePath == null || FileContentHash(filePath) is not { } contentHash) return;

        DuckDbSql.ExecuteFor(Connection, $"""
            INSERT INTO {FilesRelation} (plugin, origin, file_path, content_hash, index_version)
            VALUES ($1, $2, $3, $4, $5)
            """, plugin, origin, Path.GetFullPath(filePath), contentHash, _indexVersion!);
    }

    public void DeleteIndexedFile(string plugin, string origin) =>
        DuckDbSql.ExecuteFor(Connection, $"DELETE FROM {FilesRelation} WHERE plugin = $1 AND origin = $2", plugin, origin);

    // ADR-0046: one advance per logical projection, not per transaction inside it. A whole-plugin
    // ingest is four transactions, so a client awaiting the sequence once could otherwise read an
    // in-between state.
    private readonly Lock _projectionLock = new();
    private int _projectionDepth;
    private bool _bumpDeferred;
    private readonly List<Action> _announcements = [];

    /// <summary>The scope handed out with no store to advance — a projector holding no index still
    /// answers its callers.</summary>
    internal static readonly IDisposable NoProjectionScope = new ProjectionScope(null);

    internal IDisposable BeginProjection()
    {
        lock (_projectionLock) _projectionDepth++;
        return new ProjectionScope(this);
    }

    // Outside a scope this joins whichever transaction is active on Connection, so the caller's
    // commit or rollback decides the counter's fate with the rows. Inside one the advance is
    // deferred instead, landing after the last of those commits.
    public void BumpSequence()
    {
        lock (_projectionLock)
        {
            if (_projectionDepth > 0)
            {
                _bumpDeferred = true;
                return;
            }
        }
        DuckDbSql.ExecuteFor(Connection, $"UPDATE {SequenceRelation} SET value = value + 1");
    }

    /// <summary>Runs <paramref name="publish"/> once the projection has landed: immediately outside
    /// a scope, after the advance inside one. A subscriber is never told about rows at a sequence
    /// the store has not reached.</summary>
    internal void Announce(Action publish)
    {
        lock (_projectionLock)
        {
            if (_projectionDepth > 0)
            {
                _announcements.Add(publish);
                return;
            }
        }
        publish();
    }

    // A transaction that rolled back inside the scope still leaves the advance owed, so this can
    // over-signal — a re-read finding nothing changed — but never under-signal.
    private void EndProjection()
    {
        List<Action> announcements;
        lock (_projectionLock)
        {
            if (--_projectionDepth > 0) return;
            announcements = [.. _announcements];
            _announcements.Clear();
            if (_bumpDeferred)
            {
                _bumpDeferred = false;
                DuckDbSql.ExecuteFor(Connection, $"UPDATE {SequenceRelation} SET value = value + 1");
            }
        }
        foreach (var publish in announcements) publish();
    }

    private sealed class ProjectionScope(IndexStore? store) : IDisposable
    {
        private IndexStore? _store = store;

        // Idempotent: a second Dispose would otherwise decrement the depth twice and let the next
        // bump escape its enclosing scope.
        public void Dispose() => Interlocked.Exchange(ref _store, null)?.EndProjection();
    }

    public long CurrentSequence()
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT value FROM {SequenceRelation}";
        return Convert.ToInt64(cmd.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    // ADR-0046: raises the sequence to at least atLeast, never lowers it — Sequence must never
    // regress within one process across a rebuild.
    internal void SeedSequence(long atLeast)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"UPDATE {SequenceRelation} SET value = $1 WHERE value < $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = atLeast });
        cmd.Parameters.Add(new DuckDBParameter { Value = atLeast });
        cmd.ExecuteNonQuery();
    }
}
