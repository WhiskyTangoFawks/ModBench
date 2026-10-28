using System.Data;
using System.Diagnostics;
using System.Runtime.ExceptionServices;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex.Store;

/// <summary>The connection, DDL, validate and rebuild of the record index file, every read over it, and
/// every write verb: each transaction boundary, registration and the winner sweep.</summary>
internal sealed class Store : IDisposable
{
    internal const string FilesRelation = "mirror.files";
    internal const string PluginDerivationRelation = $"mirror.{TableDdlBuilder.PluginDerivationTable}";
    internal const string PluginDiagnosisRelation = $"mirror.{TableDdlBuilder.PluginDiagnosisTable}";
    internal const string SequenceRelation = "mirror.sequence";
    internal const string IndexVersionRelation = "mirror.index_version";

    private readonly ILogger _logger;
    private readonly string? _databasePath;
    private readonly string? _instanceRoot;
    private readonly TimeProvider _timeProvider;
    private readonly SchemaReflector _schemaReflector;
    private readonly TableDdlBuilder _ddlBuilder;
    private readonly IPluginAdapter _plugins;
    private readonly IndexWriteGate _gate;
    private readonly FilterInForce _filterInForce;
    private readonly INotificationPublisher? _notifications;
    private readonly Projection _projection;
    private IReadOnlyDictionary<string, RecordTableSchema>? _schemas;
    private PluginIngest? _pluginIngest;
    private WorkingTreeOverlay? _workingTreeOverlay;
    private bool _recordTypeViewsCreated;

    private DuckDBConnection? _connection;

    private DuckDBConnection Connection =>
        _connection ?? throw new InvalidOperationException("The store is not open.");

    /// <summary>Replaces <paramref name="table"/> with the rows of <paramref name="select"/>. The filter's matches
    /// live in the store's own tables, not in a read's context.</summary>
    internal void Materialize(string table, string select) =>
        DuckDbSql.Execute(Connection, $"CREATE OR REPLACE TABLE {table} AS ({select}\n)");

    /// <summary>Every read the record index answers.</summary>
    public RelationReads Reads { get; }

    public FilterMatches Filter { get; }

    public GameRelease Release { get; private set; }

    public IReadOnlyDictionary<string, RecordTableSchema> Schemas =>
        _schemas ?? throw new InvalidOperationException("Call Initialize before using the repository.");

    private PluginIngest Ingest =>
        _pluginIngest ?? throw new InvalidOperationException("Call Initialize before using the repository.");

    private WorkingTreeOverlay Overlay =>
        _workingTreeOverlay ?? throw new InvalidOperationException("Call Initialize before using the repository.");

    /// <summary><paramref name="openedPlugins"/> answers <see cref="RelationReads.OpenedPlugins"/>, as the store
    /// holds no header flag, master list or record count. The gate and the filter outlive the store,
    /// which a rebuild swaps beneath them.</summary>
    public Store(
        ILogger logger, string? databasePath, string? instanceRoot, SchemaReflector schemaReflector, TableDdlBuilder ddlBuilder, IPluginAdapter plugins,
        TimeProvider? timeProvider, Func<IReadOnlyDictionary<PluginAddress, PluginContent>> openedPlugins, Func<bool> indexed,
        IndexWriteGate gate, FilterInForce filterInForce, INotificationPublisher? notifications)
    {
        _logger = logger;
        _gate = gate;
        _filterInForce = filterInForce;
        _notifications = notifications;
        _projection = new Projection(this);
        _databasePath = databasePath;
        _instanceRoot = instanceRoot;
        _schemaReflector = schemaReflector;
        _ddlBuilder = ddlBuilder;
        _plugins = plugins;
        _timeProvider = timeProvider ?? TimeProvider.System;
        Reads = new RelationReads(this, openedPlugins, indexed);
        Filter = new FilterMatches(this);
    }

    /// <summary>Opens the file, or the in-memory database when no path was given. Another window
    /// holding the file answers its refusal, leaving the store unopened (ADR-0010). A missing instance root
    /// throws rather than be created.</summary>
    public string? Open()
    {
        if (_databasePath == null)
        {
            _connection = Opened("DataSource=:memory:");
            return null;
        }

        if (!Directory.Exists(_instanceRoot))
            throw new IndexFaultException($"Instance root not found: {_instanceRoot}") { Fault = IndexFault.Refused };
        Directory.CreateDirectory(Path.GetDirectoryName(_databasePath)
            ?? throw new InvalidOperationException($"Expected '{_databasePath}' to name a file in a folder."));
        try
        {
            _connection = OpenFile(_databasePath);
            return null;
        }
        catch (Exception ex) when (IsAnotherWriter(ex))
        {
            _logger.LogWarning(ex, "The record index at {Path} is held by another window", _databasePath);
            return $"This instance's record index is open in another Modbench window ({_databasePath}). Close that window, then refresh.";
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // Every other exception, not DuckDBException alone: what an unreadable file throws has
            // changed between DuckDB versions, and the answer is the same for all of them.
            _logger.LogWarning(ex, "Could not open the record index at {Path}; rebuilding it from scratch", _databasePath);
            File.Delete(_databasePath);
            _connection = OpenFile(_databasePath);
            return null;
        }
    }

    /// <summary>Whether another process holds the file, never answered by rebuilding: deleting an open
    /// file can succeed and destroy a live index. Matched on DuckDB's message, all it offers, which
    /// differs on POSIX and Windows.</summary>
    internal static bool IsAnotherWriter(Exception ex) =>
        ex.Message.Contains("lock on file", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("Conflicting lock", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("is already open in", StringComparison.OrdinalIgnoreCase);

    // DuckDB.NET duplicates in-memory connections only; a file opened again on the same path shares
    // this process's database instance. Either way the read gets its own transaction context.
    public ReadContext OpenRead()
    {
        lock (_readsGate)
        {
            if (_closedToReads) throw new IndexNotReadyException("mEdit's record index is closed to new reads while it is replaced.");
            var connection = _databasePath == null ? Opened(Connection.Duplicate()) : Opened($"DataSource={_databasePath}");
            _readsInFlight++;
            connection.Disposed += (_, _) => { lock (_readsGate) { _readsInFlight--; Monitor.PulseAll(_readsGate); } };
            return new ReadContext(connection, owned: true);
        }
    }

    private readonly object _readsGate = new();
    private int _readsInFlight;
    private bool _closedToReads;

    /// <summary>Closes the store to new reads. False when a read is still open once
    /// IndexWriteGate.HoldLimit has passed: a read never disposed would otherwise wedge the closing.
    /// </summary>
    public bool EndReads()
    {
        lock (_readsGate)
        {
            _closedToReads = true;
            var deadline = _timeProvider.GetUtcNow() + IndexWriteGate.HoldLimit;
            var aReadEnded = true;
            while (_readsInFlight > 0 && aReadEnded)
            {
                var remaining = deadline - _timeProvider.GetUtcNow();
                aReadEnded = remaining > TimeSpan.Zero && Monitor.Wait(_readsGate, remaining);
            }
            return _readsInFlight == 0;
        }
    }

    internal bool SharesFileWith(string? instanceRoot) =>
        _databasePath is { } path && instanceRoot is not null
        && string.Equals(path, IndexFile.For(instanceRoot), StringComparison.OrdinalIgnoreCase);

    private static DuckDBConnection Opened(string connectionString) => Opened(new DuckDBConnection(connectionString));

    private static DuckDBConnection Opened(DuckDBConnection connection)
    {
        try
        {
            StoreFaults.Translating(connection.Open);
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    private StoreTransaction BeginTransaction() => new(StoreFaults.Translating(Connection.BeginTransaction));

    internal bool IsInvalidated()
    {
        try
        {
            using var connection = OpenRead();
            connection.Scalar<int>("SELECT 1");
            return false;
        }
        catch (IndexFaultException ex) when (ex.Fault == IndexFault.Invalidated)
        {
            return true;
        }
    }

    public void Dispose()
    {
        bool closedToReads;
        lock (_readsGate) closedToReads = _closedToReads;
        if (!closedToReads && !EndReads())
        {
            _logger.LogError(
                "The record index at {Path} closes under a read still open after {Seconds}s; the next index opened on it may answer its old rows",
                _databasePath, IndexWriteGate.HoldLimit.TotalSeconds);
        }
        _connection?.Dispose();
    }

    // DuckDB sizes its buffer pool from the machine's memory, and cannot see the share a desktop
    // with other programs leaves it.
    private const string MemoryLimit = "1GB";

    private static DuckDBConnection OpenFile(string databasePath)
    {
        var connection = Opened($"DataSource={databasePath}");
        DuckDbSql.Execute(connection, $"SET GLOBAL memory_limit = '{MemoryLimit}'");
        return connection;
    }

    /// <summary>Discards a file written under another <see cref="IndexVersion"/> (whole-file rebuild,
    /// never partial), then creates the fixed tables and stamps the version they were built under.</summary>
    public void Initialize(GameRelease release, Func<string, string> contentStamp)
    {
        var indexVersion = IndexVersion.For(_schemaReflector, release);
        DiscardFileWrittenUnderAnotherVersion(indexVersion);
        _schemas = _schemaReflector.GetSchemas(release);
        Release = release;
        _pluginIngest = new PluginIngest(Connection, _logger, release, contentStamp);
        _workingTreeOverlay = new WorkingTreeOverlay(Connection, _logger, _schemas, release, contentStamp);
        TableDdlBuilder.CreateTables(Connection);
        DuckDbSql.Execute(Connection, $"DELETE FROM {IndexVersionRelation}");
        DuckDbSql.Execute(Connection, $"INSERT INTO {IndexVersionRelation} (value) VALUES ($1)", indexVersion);
    }

    public void CreateRecordTypeViews()
    {
        if (_recordTypeViewsCreated) return;
        _ddlBuilder.CreateRecordTypeViews(Connection, Release);
        _recordTypeViewsCreated = true;
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
                "Could not read the record index version at {Path}; rebuilding it from scratch", _databasePath);
            RebuildFile();
            return;
        }

        if (written == indexVersion) return;

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "The record index at {Path} was written under a different codec/schema version; rebuilding it from scratch",
                _databasePath);
        }
        RebuildFile();
    }

    private bool IndexedFilesTableExists()
    {
        return DuckDbSql.Scalar<long>(
            Connection, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'mirror' AND table_name = 'files'") > 0;
    }

    // Only reachable once the file has already been opened, so it can never race the second-writer
    // case IsAnotherWriter guards. Internal: ADR-0010's rebuild reuses this same
    // delete-and-reopen.
    internal void RebuildFile()
    {
        Connection.Dispose();
        File.Delete(_databasePath
            ?? throw new InvalidOperationException("An in-memory index has no file to rebuild."));
        _connection = OpenFile(_databasePath);
    }

    /// <summary>ADR-0003: unindexes each indexed plugin whose file is gone or differs from its hash.
    /// </summary>
    public void ValidateAgainstDisk() => Commit(_ =>
    {
        foreach (var key in StaleAgainstDisk())
            Unindex(key);
    });

    private List<PluginAddress> StaleAgainstDisk()
    {
        var stale = new List<PluginAddress>();
        if (_databasePath == null) return stale;

        var timer = Stopwatch.StartNew();
        var checkedCount = 0;
        foreach (var (key, filePath, contentHash) in IndexedFiles())
        {
            checkedCount++;
            if (!_plugins.Exists(filePath))
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
        return DuckDbSql.Rows(
            Connection, $"SELECT plugin, origin, file_path, content_hash FROM {FilesRelation}",
            reader => (reader.GetPluginAddress(), ResolvedFilePath(reader.GetString(2)), reader.GetString(3)));
    }

    // Null when the file cannot be read (mid-write, permissions) counts as a mismatch: an unreadable
    // file is no evidence its rows are still true.
    public string? FileContentHash(string filePath)
    {
        var hash = _plugins.HashOf(filePath);
        if (hash == null) LogUnreadable(filePath);
        return hash;
    }

    private void LogUnreadable(string filePath)
    {
        if (_logger.IsEnabled(LogLevel.Warning))
            _logger.LogWarning("Could not read {Path} to hash it; treating the record index's rows for it as stale", filePath);
    }

    /// <summary>The disk claim <paramref name="key"/>'s rows carry, or null when nothing backs them.
    /// Validate's non-compiled half asks for both at once: the path to re-hash and the hash the
    /// rows were built under.</summary>
    public (string FilePath, string ContentHash)? IndexedFile(PluginAddress key)
    {
        return DuckDbSql.Rows(
            Connection, $"SELECT file_path, content_hash FROM {FilesRelation} WHERE plugin = $1 AND origin = $2",
            reader => (ResolvedFilePath(reader.GetString(0)), reader.GetString(1)), key.Name, key.Origin) is [var claim] ? claim : null;
    }

    /// <summary>Which truth <paramref name="key"/>'s rows were derived from, or null when the store
    /// holds no rows for it.</summary>
    public DerivedFrom? DerivationOf(PluginAddress key) =>
        DuckDbSql.ScalarString(Connection,
            $"SELECT derived_from FROM {PluginDerivationRelation} WHERE plugin = $1 AND origin = $2",
            key.Name, key.Origin) is { } stamp && Enum.TryParse<DerivedFrom>(stamp, out var derivedFrom)
            ? derivedFrom
            : null;

    /// <summary>Restates which truth <paramref name="key"/>'s rows read as, leaving the file claim
    /// beside it: a refresh re-derives the rows in place, and the binary they were stamped against
    /// is still the file on disk.</summary>
    public void RestampDerivation(PluginAddress key, DerivedFrom derivedFrom)
    {
        using var tx = BeginTransaction();
        var restamped = DuckDbSql.Execute(
            Connection,
            $"UPDATE {PluginDerivationRelation} SET derived_from = $1 WHERE plugin = $2 AND origin = $3 AND derived_from <> $1",
            derivedFrom.ToString(), key.Name, key.Origin);
        if (restamped > 0) BumpSequence();
        tx.Commit();
    }

    /// <summary>The language the translated texts show in, from the next read on.</summary>
    public void SetStringsLanguage(Language language)
    {
        if (DuckDbSql.Execute(Connection, $"UPDATE {TableDdlBuilder.StringsLanguageRelation} SET language = $1 WHERE language <> $1", language.ToString()) > 0)
            BumpSequence();
    }

    /// <summary>What <paramref name="key"/>'s rows took their strings from, or null when none.</summary>
    public string? IndexedStringsRead(PluginAddress key) =>
        DuckDbSql.ScalarString(Connection, $"SELECT strings_read FROM {FilesRelation} WHERE plugin = $1 AND origin = $2", key.Name, key.Origin);

    /// <summary>The hash of the file <paramref name="key"/>'s rows were built from, or null when none.</summary>
    public string? IndexedContentHash(PluginAddress key)
    {
        using var connection = OpenRead();
        return connection.ScalarString($"SELECT content_hash FROM {FilesRelation} WHERE plugin = $1 AND origin = $2",
            key.Name, key.Origin);
    }

    // The plugin half of an Index() call, inside its transaction. A caller
    // naming no file (an in-memory mod) writes no file row, so nothing vouches for those rows and
    // the next load re-indexes.
    public void StampPluginFacts(string plugin, string origin, string? filePath, DerivedFrom derivedFrom, string? stringsRead)
    {
        DeletePluginFacts(plugin, origin);
        DuckDbSql.Execute(Connection, $"""
            INSERT INTO {PluginDerivationRelation} (plugin, origin, derived_from) VALUES ($1, $2, $3)
            """, plugin, origin, derivedFrom.ToString());
        if (filePath == null) return;
        if (!_plugins.ClaimOf(filePath, Release).Holds(out var claim, out var unread))
        {
            _logger.LogWarning(unread.Error, "Could not read {Path} to hash it, so nothing vouches for its rows: {Reason}", filePath, unread.Reason);
            return;
        }

        DuckDbSql.Execute(Connection, $"""
            INSERT INTO {FilesRelation} (plugin, origin, file_path, content_hash, strings_read)
            VALUES ($1, $2, $3, $4, $5)
            """, plugin, origin, StoredFilePath(filePath), claim.Hash, stringsRead);
        StampDiagnoses(plugin, origin, claim);
    }

    // A scan that threw is logged and leaves no rows, never a refused ingest.
    private void StampDiagnoses(string plugin, string origin, FileClaim claim)
    {
        if (!claim.Diagnoses.Holds(out var diagnoses, out var unscanned))
        {
            _logger.LogWarning(unscanned.Error, "Could not scan {Plugin} ({Origin}) for malformed records: {Reason}", plugin, origin, unscanned.Reason);
            return;
        }

        for (var ordinal = 0; ordinal < diagnoses.Count; ordinal++)
        {
            var d = diagnoses[ordinal];
            DuckDbSql.Execute(Connection, $"""
                INSERT INTO {PluginDiagnosisRelation} (plugin, origin, ordinal, anchor, defect_class, tail, message)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                """, plugin, origin, ordinal, d.Anchor, d.DefectClass, d.Tail, d.Message);
        }
    }

    public void PointFileClaimAt(PluginAddress plugin, string filePath) =>
        DuckDbSql.Execute(Connection, $"UPDATE {FilesRelation} SET file_path = $3 WHERE plugin = $1 AND origin = $2",
            plugin.Name, plugin.Origin, StoredFilePath(filePath));

    // ADR-0012: an absolute path as identity changes when the instance moves.
    private string StoredFilePath(string filePath) =>
        _instanceRoot is null ? Path.GetFullPath(filePath) : RelativeWithin(_instanceRoot, Path.GetFullPath(filePath));

    /// <summary>A place inside <paramref name="folder"/> spelled relative to it, any other place as given.</summary>
    internal static string RelativeWithin(string folder, string place) =>
        Path.GetRelativePath(folder, place) is var relative && !relative.StartsWith("..", StringComparison.Ordinal) && !Path.IsPathRooted(relative)
            ? relative
            : place;

    private string ResolvedFilePath(string stored) =>
        _instanceRoot is null ? stored : Path.GetFullPath(stored, _instanceRoot);

    /// <summary>The file claim, the derivation and the diagnoses go together: every one of them is
    /// about the rows this plugin holds, and Unindex is the verb that drops those.</summary>
    public void DeletePluginFacts(string plugin, string origin)
    {
        DuckDbSql.Execute(Connection, $"DELETE FROM {FilesRelation} WHERE plugin = $1 AND origin = $2", plugin, origin);
        DuckDbSql.Execute(Connection, $"DELETE FROM {PluginDerivationRelation} WHERE plugin = $1 AND origin = $2", plugin, origin);
        DuckDbSql.Execute(Connection, $"DELETE FROM {PluginDiagnosisRelation} WHERE plugin = $1 AND origin = $2", plugin, origin);
    }

    // ADR-0015: one advance per logical projection, not per transaction inside it. A whole-plugin
    // ingest is four transactions, so a client awaiting the sequence once could otherwise read an
    // in-between state.
    private readonly Lock _projectionLock = new();

    // Flow-local, so nesting is seen and concurrency is not.
    private readonly AsyncLocal<ProjectionScope?> _openProjection = new();

    internal ProjectionScope BeginProjection()
    {
        var scope = new ProjectionScope(EndProjection, _openProjection.Value);
        _openProjection.Value = scope;
        return scope;
    }

    private ProjectionScope OpenProjection =>
        _openProjection.Value
        ?? throw new InvalidOperationException("A row change outside Store.Commit skips the filter and the announcement.");

    public void BumpSequence()
    {
        var scope = OpenProjection;
        lock (_projectionLock) scope.BumpOwed = true;
    }

    internal void OweWinnerSweep()
    {
        var scope = OpenProjection;
        lock (_projectionLock) scope.SweepOwed = true;
    }

    /// <summary>Runs <paramref name="publish"/> after the outermost projection's advance: a
    /// subscriber is never told about rows at a sequence the store has not reached.</summary>
    internal void Announce(Action publish)
    {
        var scope = OpenProjection;
        lock (_projectionLock) scope.Announcements.Add(publish);
    }

    private void Advance() =>
        DuckDbSql.Execute(Connection, $"UPDATE {SequenceRelation} SET value = value + 1");

    // A transaction that rolled back inside the scope still leaves the advance owed, so this can
    // over-signal — a re-read finding nothing changed — but never under-signal.

    // The advance runs before the debt is cleared and before a single notification goes out, so a
    // failed UPDATE throws with both still owed rather than losing them silently.
    private void EndProjection(ProjectionScope scope)
    {
        _openProjection.Value = scope.Parent;

        // Held through the announcements, which readers of the sequence also take: the sequence
        // reaches N only once N's announcements are out, so a caller that awaited it finds them.
        lock (_projectionLock)
        {
            // Nested: the debts and the announcements are the enclosing projection's, so a batch
            // stays one sweep and one advance however many whole-plugin projections it contains.
            if (scope.Parent is { } parent)
            {
                parent.BumpOwed |= scope.BumpOwed;
                parent.SweepOwed |= scope.SweepOwed;
                parent.Announcements.AddRange(scope.Announcements);
                scope.Announcements.Clear();
                return;
            }

            if (scope.BumpOwed)
            {
                Advance();
                scope.BumpOwed = false;
            }
            var announcements = scope.Announcements.ToArray();
            scope.Announcements.Clear();
            foreach (var publish in announcements) publish();
        }
    }

    // Calls back into the store to end the scope rather than holding the store itself: the scope
    // does not own the store's lifetime, so a disposable-typed field here would claim it does.
    internal sealed class ProjectionScope(Action<ProjectionScope> endProjection, ProjectionScope? parent) : IDisposable
    {
        internal ProjectionScope? Parent { get; } = parent;
        internal bool BumpOwed { get; set; }
        internal bool SweepOwed { get; set; }
        internal List<Action> Announcements { get; } = [];
        private Action<ProjectionScope>? _endProjection = endProjection;

        // Idempotent: a second Dispose would otherwise re-announce and pop a scope it does not own.
        public void Dispose() => Interlocked.Exchange(ref _endProjection, null)?.Invoke(this);
    }

    /// <summary>ADR-0015: one monotonic counter, advanced in the same transaction as any row change.
    /// Zero until the first change lands.</summary>
    public long Sequence
    {
        get
        {
            lock (_projectionLock)
            {
                using var connection = OpenRead();
                return connection.Scalar<long>($"SELECT value FROM {SequenceRelation}");
            }
        }
    }

    // ADR-0015: raises the sequence to at least atLeast, never lowers it — Sequence
    // must never regress within one process across a rebuild.
    internal void SeedSequence(long atLeast)
    {
        DuckDbSql.Execute(Connection, $"UPDATE {SequenceRelation} SET value = $1 WHERE value < $1", atLeast);
    }

    /// <summary>The one way the rows change (ADR-0015). The outermost commit then lands them, thrown
    /// or not: the sweep they owe, a checkpoint, the filter again, one advance and their
    /// announcements. The first throw reaches the caller.</summary>
    public T Commit<T>(Func<Projection, T> write) => StoreFaults.Translating(() => CommitUntranslated(write));

    public void Commit(Action<Projection> write) => Commit(projection =>
    {
        write(projection);
        return true;
    });

    private T CommitUntranslated<T>(Func<Projection, T> write)
    {
        using var held = _gate.Enter();
        using var scope = BeginProjection();
        if (scope.Parent is not null) return write(_projection);

        T written;
        try
        {
            written = write(_projection);
        }
        catch (Exception ex)
        {
            Land(scope, ExceptionDispatchInfo.Capture(ex));
            throw;
        }
        Land(scope, first: null);
        return written;
    }

    // Each step runs whatever threw before it. A later throw is logged rather than rethrown, which
    // would hide the first.
    private void Land(ProjectionScope scope, ExceptionDispatchInfo? first)
    {
        Action[] steps = [() => { if (scope.SweepOwed) SweepWinners(); }, Checkpoint, () => _filterInForce.Reapply(this)];
        foreach (var step in steps)
        {
            try
            {
                step();
            }
            catch (Exception ex) when (first is null)
            {
                first = ExceptionDispatchInfo.Capture(ex);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                _logger.LogError(ex, "A commit failed to land after an earlier failure, which is the one rethrown");
            }
        }
        first?.Throw();
    }

    // An ingest's rows bypass the WAL, so DuckDB's own checkpoint never comes due, and the record index
    // nodes they built stay in memory it cannot evict. FORCE: a plain CHECKPOINT refuses, rather
    // than waits, while a read ends.
    private void Checkpoint()
    {
        var timer = Stopwatch.StartNew();
        DuckDbSql.Execute(Connection, "FORCE CHECKPOINT");
        if (_logger.IsEnabled(LogLevel.Debug))
            _logger.LogDebug("Checkpointed the record index in {ElapsedMs} ms", timer.ElapsedMilliseconds);
    }

    /// <summary>What one commit owes beyond its rows.</summary>
    internal sealed class Projection(Store store)
    {
        /// <summary>Owed by rows that moved which record wins a FormKey; the outermost commit sweeps
        /// once for all of them.</summary>
        public void OweWinnerSweep() => store.OweWinnerSweep();

        public void Announce(Func<long, INotification> announcement) =>
            store.Announce(() => store._notifications?.Publish(announcement(store.Sequence)));

        /// <summary>ADR-0015: a whole plugin re-derived or removed has too many rows to name, and can
        /// move the winner of every FormKey it holds.</summary>
        public void PluginChanged(PluginAddress key)
        {
            OweWinnerSweep();
            Announce(sequence => new PluginChangedNotification(key, sequence));
        }

        public void ReadFailedOrRecovered(PluginAddress key) => Announce(sequence => new PluginChangedNotification(key, sequence));
    }

    /// <summary>Indexes a compiled plugin's tree as <see cref="IndexBinary"/> indexes a binary. The tree
    /// is the plugin's truth however many records its binary holds, and it refuses a FormKey two
    /// documents claim before any is indexed.</summary>
    public void IndexTree(IPluginDocuments documents, PluginMetadata registered, string? filePath, CancellationToken token) =>
        Index(documents, registered, filePath, DerivedFrom.SourceTree, stringsRead: null, token);

    /// <summary>A binary whose documents miss a record it holds, or that holds one FormKey in two
    /// groups, is not indexed, and the failure says which. xEdit refuses a duplicate FormID to load.</summary>
    public LoadFailure? IndexBinary(
        IPluginDocuments documents, PluginMetadata registered, string? filePath, DerivedFrom derivedFrom, string? stringsRead, CancellationToken token) =>
        Index(documents, registered, filePath, derivedFrom, stringsRead, token);

    // Replaces whatever the key held, and stamps the file's hash and diagnosis (ADR-0003); a null
    // path claims no file backs the rows (ADR-0012).
    private LoadFailure? Index(IPluginDocuments documents, PluginMetadata registered, string? filePath, DerivedFrom derivedFrom, string? stringsRead, CancellationToken token)
    {
        var (plugin, origin) = (registered.Name, registered.Origin);
        var schemas = Schemas;

        // One transaction for the whole reindex so a throw partway leaves the read model intact
        // rather than a partial snapshot.
        using var tx = BeginTransaction();

        // The `registrations` row lands in the same transaction as the rows, which answer nothing
        // without it.
        UpsertRegistration(registered);
        // And the facts about these rows — the disk claim, the derivation, the diagnosis — replaced
        // with them rather than beside them.
        StampPluginFacts(plugin, origin, filePath, derivedFrom, stringsRead);

        var ingested = StoreFaults.Translating(() => Ingest.IndexPlugin(documents, plugin, origin, schemas, token));
        if (derivedFrom != DerivedFrom.SourceTree && BinaryRefused(registered, ingested.Records) is { } refused) return refused;
        BumpSequence();

        var commitTimer = Stopwatch.StartNew();
        tx.Commit();
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug(
                "Index {Plugin}: ingest {IngestMs} ms (prepare {PrepareMs} ms, append {AppendMs} ms), commit {CommitMs} ms",
                plugin, ingested.IngestMs, ingested.PrepareMs, ingested.AppendMs, commitTimer.ElapsedMilliseconds);
        }
        return null;
    }

    // The duplicate first: it is a defect in the bytes, where a shortfall may be mEdit's own.
    private LoadFailure? BinaryRefused(PluginMetadata registered, int read)
    {
        var heldTwice = Ingest.FormKeysHeldTwice(registered.Name, registered.Origin);
        if (heldTwice.Count > 0)
        {
            return new LoadFailure("duplicate FormKey " + string.Join("; ", heldTwice.Select(held =>
                $"{held.FormKey}, in its {Listed([.. held.RecordTypes.Select(Schemas.DisplayNameFor)])} groups")), IsDiagnosis: true);
        }
        return read < registered.RecordCount ? new LoadFailure($"mEdit read {read} of its {registered.RecordCount} records") : null;
    }

    private static string Listed(string[] names) =>
        names.Length == 1 ? names[0] : $"{string.Join(", ", names[..^1])} and {names[^1]}";

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
        using var tx = BeginTransaction();

        Ingest.DeleteAllRowsFor(plugin, origin);
        // The plugin's facts go with the rows they describe — Unindex is the file-gone verb, so
        // leaving them behind would leave the files table asserting rows the record index does not hold.
        DeletePluginFacts(plugin, origin);
        DeleteRegistration(plugin, origin);
        BumpSequence();

        tx.Commit();
    }

    // ADR-0013: one row per registered plugin, carrying its load index.
    private void UpsertRegistration(PluginMetadata registered)
    {
        DeleteRegistration(registered.Name, registered.Origin);
        DuckDbSql.Execute(
            Connection,
            $"INSERT INTO {TableDdlBuilder.RegistrationsRelation} (plugin, origin, load_order_idx, is_light) VALUES ($1, $2, $3, $4)",
            registered.Name, registered.Origin, registered.LoadOrderIndex, registered.IsLight);
    }

    /// <summary>Upserts the plugin's <c>registrations</c> row: its indexed facts answer with no re-index
    /// (ADR-0012). Winners stay stale until the next sweep.</summary>
    public void Register(PluginMetadata registered)
    {
        using var tx = BeginTransaction();
        Respell(registered.Key, registered.Path);
        UpsertRegistration(registered);
        BumpSequence();
        tx.Commit();
    }

    // Every table compares plugin names without case, so rows spelled before a case-only change still
    // belong to the plugin; they are renamed to the file's spelling now, with no re-read.
    private void Respell(PluginAddress now, string path)
    {
        var registered = DuckDbSql.Rows(
            Connection, $"SELECT plugin, origin FROM {TableDdlBuilder.RegistrationsRelation} WHERE plugin = $1 AND origin = $2",
            reader => reader.GetPluginAddress(), now.Name, now.Origin);
        if (registered is not [var spelled] || spelled == now) return;

        foreach (var (relation, pluginColumn, originColumn) in TableDdlBuilder.MirroredPluginNames)
        {
            DuckDbSql.Execute(Connection, $"""
                UPDATE {relation} SET {pluginColumn} = $1, {originColumn} = $2
                WHERE {pluginColumn} = $1 AND {originColumn} = $2
                """, now.Name, now.Origin);
        }
        PointFileClaimAt(now, path);
    }

    /// <summary>Removes <paramref name="key"/>'s <c>registrations</c> row and nothing else: its rows
    /// remain and answer nothing. Winner state is stale until the next sweep.</summary>
    public void Unregister(PluginAddress key)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Unregistering {Plugin} from {Origin}", key.Name, key.Origin);
        }
        using var tx = BeginTransaction();
        DeleteRegistration(key.Name, key.Origin);
        BumpSequence();
        tx.Commit();
    }

    /// <summary>ADR-0013: every plugin the record index currently registers: what a reconcile diffs the
    /// incoming snapshot against, since a freshly opened file still carries the last run's
    /// registrations.</summary>
    public IReadOnlyList<PluginAddress> RegisteredPlugins()
    {
        using var connection = OpenRead();
        return connection.Rows($"SELECT plugin, origin FROM {TableDdlBuilder.RegistrationsRelation}",
            reader => reader.GetPluginAddress());
    }

    private void DeleteRegistration(string plugin, string origin)
    {
        DuckDbSql.Execute(
            Connection, $"DELETE FROM {TableDdlBuilder.RegistrationsRelation} WHERE plugin = $1 AND origin = $2", plugin, origin);
    }

    /// <summary>Wholesale rather than incremental because there is no smaller correct unit:
    /// registering a plugin can move the winner of every FormKey it holds. Measured at ~75 ms
    /// on a 48,000-record, 60-plugin fixture.</summary>
    public void UpdateWinners(IReadOnlyList<RegisteredPlugin> active)
    {
        using var tx = BeginTransaction();
        ReplaceActive(active);
        UpdateWinnersCore();
        BumpSequence();
        tx.Commit();
    }

    // The same sweep for a projection that moved rows without moving the load order: which plugins
    // are active cannot change here, so the set the last sweep was handed still holds.
    private void SweepWinners()
    {
        var timer = Stopwatch.StartNew();
        using (var tx = BeginTransaction())
        {
            UpdateWinnersCore();
            BumpSequence();
            tx.Commit();
        }
        if (_logger.IsEnabled(LogLevel.Debug))
            _logger.LogDebug("Swept winners in {ElapsedMs} ms", timer.ElapsedMilliseconds);
    }

    // Replaced whole, never diffed (ADR-0013).
    private void ReplaceActive(IReadOnlyList<RegisteredPlugin> active)
    {
        DuckDbSql.Execute(Connection, $"DELETE FROM {TableDdlBuilder.ActiveRelation}");
        foreach (var (plugin, loadOrderIndex) in active.Select((plugin, index) => (plugin, index)))
        {
            DuckDbSql.Execute(
                Connection, $"INSERT INTO {TableDdlBuilder.ActiveRelation} (plugin, origin, load_order_idx) VALUES ($1, $2, $3)",
                plugin.Name, plugin.Origin, loadOrderIndex);
        }
    }

    // The sweep itself, unwrapped: a caller already inside a transaction (the projection verbs
    // below) calls this directly, since DuckDB refuses a second BeginTransaction on one connection.
    private void UpdateWinnersCore()
    {
        DuckDbSql.Execute(Connection, $"DELETE FROM {TableDdlBuilder.WinnersRelation}");

        // QUALIFY and the (plugin, origin) tiebreak make a load_order_idx tie deterministic.
        DuckDbSql.Execute(Connection, $"""
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

        using var tx = BeginTransaction();
        var projected = StoreFaults.Translating(() => Overlay.ProjectDocuments(key, deltas));
        BumpSequence();
        tx.Commit();
        // Only a delta that added or removed a row can move winner status. Re-swept for the whole
        // load order rather than per FormKey because UpdateWinners is the one definition of winning
        // (measured at 18 ms over 48k records).
        if (projected.Structural) OweWinnerSweep();
        return projected.Touched;
    }

    /// <summary>Sets each listed row to the state it is now in (ADR-0007), in one advance.</summary>
    public void SetWorkingTreeStates(PluginAddress key, IReadOnlyList<(string FormKey, WorkingTreeState State)> moved)
    {
        using var tx = BeginTransaction();
        foreach (var (formKey, state) in moved)
        {
            DuckDbSql.Execute(Connection, $"""
                UPDATE {EffectiveRows} SET working_tree_state = $4
                WHERE form_key = $1 AND plugin = $2 AND origin = $3
                """, formKey, key.Name, key.Origin, state.Stored());
        }
        BumpSequence();
        tx.Commit();
    }

    public Dictionary<string, WorkingTreeState> HeldWorkingTreeStates(PluginAddress key)
    {
        return LastWins(DuckDbSql.Rows(Connection, $"""
            SELECT form_key, working_tree_state FROM {EffectiveRows}
            WHERE plugin = $1 AND origin = $2 AND working_tree_state <> '{WorkingTreeState.None.Stored()}'
            """, reader => KeyValuePair.Create(reader.GetString(0), WorkingTreeStates.FromStored(reader.GetString(1))), key.Name, key.Origin));
    }

    // --- What the rows hold ---

    // The projection reads the plugin's rows whether it is active or not (ADR-0012).
    public (string RecordType, string? EditorId, string ContentHash)? StoredRow(PluginAddress key, string formKey)
    {
        return DuckDbSql.Rows(
            Connection, $"SELECT record_type, editor_id, content_hash FROM {EffectiveRows} WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            reader => (reader.GetString(0), reader.GetStringOrNull(1), reader.GetString(2)),
            formKey, key.Name, key.Origin) is [var row, ..] ? row : null;
    }

    public Dictionary<string, string> EffectiveContentHashes(PluginAddress key)
    {
        return LastWins(DuckDbSql.Rows(
            Connection, $"SELECT form_key, content_hash FROM {EffectiveRows} WHERE plugin = $1 AND origin = $2",
            reader => KeyValuePair.Create(reader.GetString(0), reader.GetString(1)), key.Name, key.Origin));
    }

    // One row per source document: every Effective record no document embeds. A worldspace's TopCell
    // is embedded, while an exterior cell has a directory.
    private static readonly string DocumentStamps = $"""
        SELECT r.form_key, r.content_hash
        FROM mirror.records r
        WHERE r.plugin = $1 AND r.origin = $2
          AND NOT EXISTS (
            SELECT 1 FROM mirror.holdings h
            WHERE h.child = r.form_key AND h.plugin = r.plugin AND h.origin = r.origin
              AND h.slot <> {HoldingSlots.Exterior})
        """;

    /// <summary>The content stamp of each source document the rows were derived from, by the key of
    /// the record it files.</summary>
    public Dictionary<string, string> HeldDocumentStamps(PluginAddress key)
    {
        return LastWins(DuckDbSql.Rows(
            Connection, DocumentStamps, reader => KeyValuePair.Create(reader.GetString(0), reader.GetString(1)), key.Name, key.Origin));
    }

    // A plugin can hold one FormKey twice and the rows carry no key, so the last row speaks.
    private static Dictionary<string, T> LastWins<T>(IEnumerable<KeyValuePair<string, T>> rows)
    {
        var byKey = new Dictionary<string, T>(StringComparer.Ordinal);
        foreach (var (key, value) in rows) byKey[key] = value;
        return byKey;
    }

}
