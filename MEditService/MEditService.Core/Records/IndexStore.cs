using System.Diagnostics;
using System.Globalization;
using DuckDB.NET.Data;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

/// <summary>
/// #606 stage 2: the connection/DDL/validate/rebuild collaborator extracted out of
/// <see cref="DuckDbRecordIndex"/> — opening the file (or an in-memory database), the
/// <c>mirror.files</c>/<see cref="IndexVersion"/> machinery that decides whether a file must be
/// rebuilt from scratch, and the by-content validation against disk. Internal, private to the
/// <c>Records</c> module — not part of any public seam.
///
/// <para><b>Validate is a pure question, not an action</b> (deliberately, by design review): this
/// class never removes a plugin's rows itself. <see cref="ValidateAgainstDisk"/> returns the stale
/// set; the caller (<see cref="DuckDbRecordIndex.Initialize"/>) is the one that already owns
/// <c>Unindex</c> as an orchestrating verb spanning registration and every ingest-owned table, so
/// acting on the stale set stays there rather than this class calling back into its own caller.</para>
/// </summary>
internal sealed class IndexStore
{
    /// <summary>#585: the file-mirror table, named once so the writes, the open-time validation
    /// and the version check cannot drift onto different spellings of it.</summary>
    private const string FilesRelation = "mirror.files";

    private readonly TableDdlBuilder _ddlBuilder;
    private readonly ILogger _logger;
    private readonly string? _databasePath;

    // The version the rows in this file were written under (IndexVersion), resolved once at
    // Initialize once the game release is known — same "one game for its whole lifetime" reasoning
    // DuckDbRecordIndex itself already applies to _release/_conditionCodec.
    private string? _indexVersion;

    public DuckDBConnection Connection { get; private set; }

    public IndexStore(TableDdlBuilder ddlBuilder, ILogger logger, string? databasePath)
    {
        _ddlBuilder = ddlBuilder;
        _logger = logger;
        _databasePath = databasePath;
        Connection = Open();
    }

    /// <summary>
    /// Opens the index, rebuilding it from scratch if the file cannot be opened at all — a DuckDB
    /// storage-format change on upgrade, or a truncated/corrupt file (ADR-0001 point 6). The index
    /// is derived state and losing it costs one cold load, which is what a load costs today anyway,
    /// so a rebuild is strictly better than refusing to start.
    /// </summary>
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
            // Deliberately every other exception rather than DuckDBException alone: what a file
            // DuckDB cannot make sense of throws is its own business and has changed between
            // versions, and the answer here — throw the file away and start again — is the same for
            // all of them. The index is derived state; losing it costs one cold load.
            _logger.LogWarning(ex, "Could not open the index at {Path}; rebuilding it from scratch", _databasePath);
            File.Delete(_databasePath);
            return OpenFile();
        }
    }

    /// <summary>
    /// Whether this open failed because <b>another process already holds the file</b> — a second
    /// Modbench window on the same game (ADR-0001 point 6), which is a different failure from a
    /// corrupt one and must never be answered by rebuilding: deleting a file another process has
    /// open succeeds on POSIX and destroys that window's live index, which is precisely the "silent
    /// divergence" the decision rejects. Such an open throws <see cref="IndexHeldElsewhereException"/>
    /// naming the file instead (#588), which <c>PUT /load-order</c> answers 423 Locked.
    ///
    /// <para>Matched on DuckDB's own message because that is the only thing it offers — the lock
    /// conflict and a corrupt file arrive as the same exception type. Both platforms' wordings share
    /// DuckDB's own prefix, and an unrecognised wording degrades to the rebuild branch, so this is a
    /// guard against the known case rather than a claim to have enumerated every one.</para>
    /// </summary>
    internal static bool IsAnotherWriter(Exception ex) =>
        ex.Message.Contains("lock on file", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("Conflicting lock", StringComparison.OrdinalIgnoreCase);

    private DuckDBConnection OpenFile()
    {
        var connection = new DuckDBConnection($"DataSource={_databasePath}");
        connection.Open();
        return connection;
    }

    /// <summary>
    /// The DDL/version half of <see cref="DuckDbRecordIndex.Initialize"/>: discard a file written
    /// under another <see cref="IndexVersion"/> (whole-file rebuild, never partial), then create the
    /// fixed tables for <paramref name="release"/>.
    /// </summary>
    public void Initialize(GameRelease release, string indexVersion)
    {
        _indexVersion = indexVersion;
        DiscardFileWrittenUnderAnotherVersion();
        _ddlBuilder.CreateTables(Connection, release);
    }

    /// <summary>
    /// #585 / ADR-0001: a codec or schema version change invalidates the <b>whole</b> file. There is
    /// no partial answer — the stored documents are the codec's output and the generated views are
    /// the reflector's, so a file written under another version describes a read model this process
    /// does not have — and no in-place migration either, which is what "rebuilt from scratch" means:
    /// the file is deleted and reopened empty, costing exactly one cold load.
    /// </summary>
    private void DiscardFileWrittenUnderAnotherVersion()
    {
        if (_databasePath == null) return;

        List<string> versions;
        try
        {
            // Asked of the catalog first, so that "this file has never been written to" — the
            // ordinary first open, where the table simply does not exist yet — is an answer rather
            // than an exception. That separation is what lets the catch below mean something: past
            // this point, a file that cannot answer is a file this process cannot reason about, and
            // the safe reading of an unreadable mirror is that it is stale.
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

    /// <summary>Throws the file away and opens an empty one in its place. Only reachable once the
    /// file has already been opened successfully, so it can never race the second-writer case
    /// <see cref="IsAnotherWriter"/> guards.</summary>
    private void RebuildFile()
    {
        Connection.Dispose();
        File.Delete(_databasePath!);
        Connection = OpenFile();
    }

    /// <summary>
    /// #585 / ADR-0001: validity is by content, never by clock. Every plugin the file holds rows for
    /// is checked against the file those rows were built from and the stale ones — gone, or moved to
    /// different bytes — are returned for the caller to <c>Unindex</c>, so the next load re-indexes
    /// them in place and no read can ever answer from rows the disk no longer backs. A hash, never an
    /// <c>mtime</c>: MO2, xEdit, Steam and the user all write these files and a preserved timestamp
    /// is free.
    ///
    /// <para>Registrations are <i>not</i> cleared (ADR-0001 point 4, amended by ADR-0044): the
    /// <c>registrations</c> rows are the last known load order, and the first reconcile corrects
    /// them — which is what lets a restart followed by an identical snapshot cost nothing. This
    /// method only ever reads and reports; it never removes a registration itself.</para>
    /// </summary>
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
                        "{Plugin} ({Origin}) is no longer on disk at {Path}; removing its rows",
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

    /// <summary>The content hash of one plugin file, or <see langword="null"/> when it cannot be
    /// read at all — a file another process is mid-write on, or one whose permissions changed. Null
    /// counts as a mismatch at <see cref="ValidateAgainstDisk"/>: an unreadable file is not evidence
    /// that the rows built from it are still true. Shared with the runtime mirror
    /// (<see cref="PluginBinaryHash"/>), which has to produce the identical string for the identical
    /// bytes or a real change would read as a touch.</summary>
    private string? FileContentHash(string filePath)
    {
        var hash = PluginBinaryHash.OfFile(filePath);
        if (hash == null && _logger.IsEnabled(LogLevel.Warning))
        {
            _logger.LogWarning("Could not read {Path} to hash it; treating the index's rows for it as stale", filePath);
        }
        return hash;
    }

    /// <summary>See <see cref="IRecordIndex.IndexedContentHash"/>.</summary>
    public string? IndexedContentHash(PluginKey key) =>
        DuckDbSql.ScalarString(Connection,
            $"SELECT content_hash FROM {FilesRelation} WHERE plugin = $1 AND origin = $2",
            key.Name, key.Origin!);

    // #585 / ADR-0001: the file half of an Index() call — what was on disk, and what shape its rows
    // were written in. Called inside Index()'s own transaction (owned by DuckbRecordIndex), so a
    // re-index that throws partway leaves neither the rows nor the claim about them behind. A caller
    // that names no file (an in-memory mod, which is every fixture in the suite and the New Plugin
    // gesture's freshly written one before it has a stamp worth taking) writes no row: the index then
    // holds those rows without claiming any disk file backs them, which is exactly true, and the next
    // load re-indexes.
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
}
