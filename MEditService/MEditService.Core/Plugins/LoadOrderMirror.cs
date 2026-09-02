using System.Diagnostics;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Plugins;

/// <summary>See <see cref="ILoadOrderMirror"/>.</summary>
public sealed class LoadOrderMirror(
    IRecordIndexFactory indexFactory,
    ILogger<LoadOrderMirror>? logger = null,
    IModImporter? modImporter = null,
    SchemaReflector? schemaReflector = null) : ILoadOrderMirror, IDisposable
{
    private readonly Lock _lock = new();
    private readonly ILogger<LoadOrderMirror> _logger = logger ?? NullLogger<LoadOrderMirror>.Instance;
    private readonly IRecordIndexFactory _indexFactory = indexFactory;
    private readonly IModImporter _modImporter = modImporter ?? new DefaultModImporter();
    // The same reflector ReconcileHeadStructurally's SourceRecordType.Resolve needs for a
    // container's Head-only deletion — DI already registers SchemaReflector as its own singleton
    // (Program.cs), so this is a direct constructor parameter rather than routed through
    // IRecordIndexFactory, which has no other reason to carry it.
    private readonly SchemaReflector _schemaReflector = schemaReflector ?? new SchemaReflector();
    private LoadOrder? _loadOrder;
    private IRecordIndex? _index;
    // The reconcile's own progress. Guarded by _lock like _loadOrder/_index — written by
    // the reconciling thread as each plugin lands, read by whoever asks for Status meanwhile.
    private readonly List<IndexedPlugin> _indexed = [];
    private bool _conflictsComputed;
    private int _plannedCount;

    // ADR-0044: a copy that failed to open is a row in an error state, and it stays one until its
    // bytes change — keyed by the content hash the failure was observed against, so a snapshot that
    // merely mentions it again (every checkbox toggle does) never pays the parse a second time,
    // while a fix made in xEdit is picked up by the very next reconcile.
    private readonly Dictionary<string, (PluginKey Key, string? Hash)> _failedHashes = new(StringComparer.OrdinalIgnoreCase);

    // At most one reconcile or teardown at a time, and an in-flight reconcile stops promptly
    // when another arrives. Two mechanisms, because one is not enough: the token *asks* the loop to
    // stop, and the gate waits until it actually has. Cancelling without draining is the dangerous
    // half — it would let a teardown dispose the DuckDB connection while the loop is still writing
    // to it, which is a native crash rather than an exception. Deliberately not _lock: the
    // reconciling thread takes _lock briefly on every plugin, so a waiter holding it could never be
    // signalled.
    private readonly SemaphoreSlim _reconcileGate = new(1, 1);
    private CancellationTokenSource? _reconcileCancellation;
    private bool _disposed;

    /// <summary>Cancels any in-flight reconcile, waits for it to stop, and takes the exclusive right
    /// to reconcile or tear down. Always paired with <see cref="ExitExclusive"/> in a finally.</summary>
    private void EnterExclusive()
    {
        // Cancel and dispose both happen under _lock, so a token can never be cancelled after it has
        // been disposed.
        lock (_lock) _reconcileCancellation?.Cancel();
        _reconcileGate.Wait();
    }

    private void ExitExclusive() => _reconcileGate.Release();

    private GameRelease _gameRelease;

    public ILoadOrder? LoadOrder { get { lock (_lock) return _loadOrder; } }
    public IRecordReads? Reads { get { lock (_lock) return _index?.At(RecordRef.Effective); } }
    public IRecordIndex? Index { get { lock (_lock) return _index; } }

    /// <summary>
    /// See <see cref="ILoadOrderMirror.WriteGate"/>. One per mirror, created with it and never
    /// replaced — a reconcile or a rebuild swaps <see cref="_index"/> underneath it, which is exactly
    /// the moment the ordering it provides matters most. Not guarded by <c>_lock</c>: it is readonly,
    /// and it is by construction the outer of the two (a caller that took <c>_lock</c> first and then
    /// waited here would deadlock against a write holding the gate and waiting for <c>_lock</c>).
    /// </summary>
    public IndexWriteGate WriteGate { get; } = new();

    /// <summary>See <see cref="ILoadOrderMirror.RequireScope"/>.</summary>
    public (ILoadOrder LoadOrder, IRecordReads Reads) RequireScope()
    {
        var (loadOrder, index) = RequireScopeCore();
        return (loadOrder, index.At(RecordRef.Effective));
    }

    /// <summary>
    /// The actual gate behind <see cref="RequireScope"/> — every write-side method below
    /// needs the concrete <see cref="Plugins.LoadOrder"/> and the write-capable <see cref="IRecordIndex"/>
    /// underneath it, not the narrower (<see cref="ILoadOrder"/>, <see cref="IRecordReads"/>) the
    /// public method hands out. One lock, one null check, one message: <see cref="CreatePlugin"/>,
    /// <see cref="ReindexPlugin(PluginKey)"/> and <see cref="ApplyFilter"/> all go through this
    /// instead of each re-writing "if (_loadOrder is null) throw" for itself.
    /// </summary>
    private (LoadOrder LoadOrder, IRecordIndex Index) RequireScopeCore()
    {
        lock (_lock)
        {
            if (_loadOrder is not { } loadOrder || _index is not { } index)
                throw new NoLoadOrderException();
            return (loadOrder, index);
        }
    }

    /// <summary>
    /// What the mirror can honestly say about itself right now (ADR-0035) — the read behind
    /// <c>GET /load-order/status</c>. Assembled from live state rather than cached, so it cannot
    /// drift from the reconcile it describes; failures come straight off the load order's own list
    /// rather than being copied into a second place that could disagree with it.
    /// </summary>
    public LoadOrderStatus Status
    {
        get
        {
            lock (_lock)
            {
                if (_loadOrder is null) return LoadOrderStatus.None;
                var state = _conflictsComputed ? LoadOrderState.Ready : LoadOrderState.Reconciling;
                return new LoadOrderStatus(state, _plannedCount, [.. _indexed], _conflictsComputed, _loadOrder.LoadFailures);
            }
        }
    }

    public void Reconcile(
        string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease,
        string? instanceRoot = null)
    {
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Reconciling load order. GameDir={GameDir} Instance={Instance} Plugins={Count} Game={Game}",
                gameDirectory, instanceRoot, plugins.Count, gameRelease);
        }

        EnterExclusive();
        try
        {
            var token = BeginReconcile();
            var (loadOrder, index) = EnsureScope(gameDirectory, gameRelease, instanceRoot);
            var resolved = Plugins.LoadOrder.Resolve(gameDirectory, gameRelease, plugins);
            ReconcileProgressively(loadOrder, index, resolved, token);
        }
        catch (OperationCanceledException ex)
        {
            // Superseded: whatever landed so far stays held and registered; the reconcile that
            // cancelled this one owns the rest. Nothing to tear down, because nothing was built
            // that the successor will not want (ADR-0044: there is no load order to unwind).
            _logger.LogWarning(ex, "Load order reconcile was superseded before it completed");
            throw;
        }
        catch (IndexHeldElsewhereException ex)
        {
            // Refused, not failed — the user has two windows on one instance, and nothing is
            // held here (EnsureScope tore the previous scope down before the open that refused).
            _logger.LogWarning(ex, "Load order refused: the index at {Path} is held by another window", ex.IndexPath);
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Load order reconcile failed");
            throw;
        }
        finally
        {
            EndReconcile();
            ExitExclusive();
        }
    }

    /// <summary>Arms a fresh cancellation token for this reconcile. Called with the exclusive right
    /// held, so no other reconcile can be in flight.</summary>
    private CancellationToken BeginReconcile()
    {
        var cts = new CancellationTokenSource();
        lock (_lock) _reconcileCancellation = cts;
        return cts.Token;
    }

    private void EndReconcile()
    {
        lock (_lock)
        {
            var cts = _reconcileCancellation;
            _reconcileCancellation = null;
            cts?.Dispose();
        }
    }

    /// <summary>
    /// The load order and index this snapshot reconciles against — the ones already held when the
    /// snapshot names the same instance, game directory and release, else a fresh pair replacing
    /// whatever was held. ADR-0001: the MO2 instance is what gives the index a home — one
    /// persistent file per instance, so a fresh open finds whatever the last run left there,
    /// registrations included (ADR-0044). Never wider than the instance: `origin` is a mod folder
    /// name, unique only within one. Published before any plugin is opened, which is what makes
    /// the reconcile progressive (ADR-0035).
    /// </summary>
    private (LoadOrder LoadOrder, IRecordIndex Index) EnsureScope(
        string gameDirectory, GameRelease gameRelease, string? instanceRoot)
    {
        lock (_lock)
        {
            if (_loadOrder is { } held && _index is { } index && SameScope(held, gameDirectory, gameRelease, instanceRoot))
                return (held, index);
            DisposeCurrent();
        }

        _logger.LogDebug("Initializing DuckDB record index");
        var createTimer = Stopwatch.StartNew();
        var fresh = _indexFactory.Create(gameRelease, instanceRoot);
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("DuckDB record index initialized in {ElapsedMs} ms", createTimer.ElapsedMilliseconds);
        }
        var loadOrder = new LoadOrder(gameDirectory, instanceRoot, gameRelease, _logger);

        lock (_lock)
        {
            _indexed.Clear();
            _failedHashes.Clear();
            _conflictsComputed = false;
            _plannedCount = 0;
            _loadOrder = loadOrder;
            _index = fresh;
            _gameRelease = gameRelease;
        }
        return (loadOrder, fresh);
    }

    private static bool SameScope(LoadOrder held, string gameDirectory, GameRelease gameRelease, string? instanceRoot) =>
        held.GameRelease == gameRelease
        && SamePath(held.DataFolderPath, gameDirectory)
        && (held.InstanceRoot, instanceRoot) switch
        {
            (null, null) => true,
            ({ } a, { } b) => SamePath(a, b),
            _ => false,
        };

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);

    private static string KeyOf(PluginKey key) => $"{key.Origin}\0{key.Name}";

    /// <summary>
    /// ADR-0044's reconcile, over the resolved snapshot. The diff is computed first and without
    /// side effects: an identical snapshot returns before touching the index or the status, which
    /// is what makes a redundant PUT free. Then, in order: every registration the snapshot no
    /// longer names is dropped (before anything new is opened, so a freshly opened index file's
    /// last-run rows stop answering as early as possible); every held copy whose registration moved
    /// is re-registered, SQL-only; every copy new to the load order is opened and registered or
    /// indexed, progressively; then one winner sweep and one filter re-materialization.
    /// </summary>
    private void ReconcileProgressively(
        LoadOrder loadOrder, IRecordIndex index, IReadOnlyList<ResolvedPlugin> resolved, CancellationToken token)
    {
        var wanted = resolved.ToDictionary(r => KeyOf(r.Key), StringComparer.OrdinalIgnoreCase);
        var held = loadOrder.Plugins.ToDictionary(p => KeyOf(p.Key), StringComparer.OrdinalIgnoreCase);

        IReadOnlyList<PluginKey> failed;
        lock (_lock) failed = [.. _failedHashes.Values.Select(v => v.Key)];
        // Registered, held, or held only as a failure row — a copy the snapshot no longer names
        // leaves by every one of those doors, so a stale error row cannot outlive its copy.
        var leaving = index.RegisteredPlugins()
            .Concat(loadOrder.Plugins.Select(p => p.Key))
            .Concat(failed)
            .Where(k => !wanted.ContainsKey(KeyOf(k)))
            .DistinctBy(KeyOf, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var moved = resolved
            .Where(r => held.TryGetValue(KeyOf(r.Key), out var h) && h.Registration != r.Registration)
            .ToList();
        // A copy in an error state whose bytes have not changed is not arriving: retrying it would
        // pay the failed parse again on every snapshot that merely mentions it.
        var arriving = resolved.Where(r => !held.ContainsKey(KeyOf(r.Key)) && !StillFailing(r)).ToList();

        bool conflictsComputed;
        lock (_lock) conflictsComputed = _conflictsComputed;
        if (leaving.Count == 0 && moved.Count == 0 && arriving.Count == 0 && conflictsComputed)
        {
            _logger.LogDebug("Load order snapshot is identical to what is held; nothing to reconcile");
            return;
        }

        lock (_lock)
        {
            _conflictsComputed = false;
            _plannedCount = resolved.Count;
        }

        foreach (var key in leaving)
        {
            index.Unregister(key);
            loadOrder.Remove(key);
            lock (_lock)
            {
                _indexed.RemoveAll(i => i.Name.Equals(key.Name, StringComparison.OrdinalIgnoreCase)
                    && i.Origin.Equals(key.Origin, StringComparison.OrdinalIgnoreCase));
                _failedHashes.Remove(KeyOf(key));
            }
        }

        foreach (var plugin in moved)
        {
            // ADR-0044: a reorder, an enable, a disable, a change of which copy wins — all
            // the same SQL-only move: no re-read, no re-index, and the DuckDB connection never
            // changes, which is what makes this safe to apply live and unprompted.
            var metadata = loadOrder.Update(held[KeyOf(plugin.Key)], plugin.Registration);
            index.Register(metadata.Key, metadata.Registration);
        }

        // Two numbers ADR-0035 makes distinct — time to the first queryable plugin (the tree
        // becomes usable) and time to the winner sweep completing. Measured here rather than
        // client-side, where the 500 ms status poll caps the resolution.
        var timer = Stopwatch.StartNew();
        long? firstUsableMs = null;

        // Open and index one plugin at a time. Opening the whole set first would cost the same
        // total time but make every plugin wait on the slowest one before any of them could be
        // indexed, and bury each open failure until the end.
        foreach (var plugin in arriving)
        {
            // At the top of each plugin rather than mid-plugin: a plugin is indexed in one
            // transaction, and abandoning it partway would either roll back work already paid for or
            // leave the half-written state this exists to prevent. The cost of the coarser check is
            // at most one plugin's indexing after the cancel.
            token.ThrowIfCancellationRequested();

            if (loadOrder.Open(plugin) is not { } metadata)
            {
                lock (_lock) _failedHashes[KeyOf(plugin.Key)] = (plugin.Key, PluginBinaryHash.OfFile(plugin.Path));
                continue;
            }
            lock (_lock) _failedHashes.Remove(KeyOf(plugin.Key));

            RegisterOrIndex(loadOrder, index, metadata, token);
            firstUsableMs ??= timer.ElapsedMilliseconds;
        }

        // The whole-set sweep, and the moment conflict information becomes correct: a plugin that
        // arrived earlier was browsable but its winner state was not yet decided (ADR-0035).
        _logger.LogDebug("Computing winners");
        var winnersTimer = Stopwatch.StartNew();
        index.UpdateWinners();
        lock (_lock) _conflictsComputed = true;
        // Any of the above can change which records match an active filter.
        ReapplyFilter();

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Load order reconciled in {TotalMs} ms: {Arrived} arrived, {Moved} moved, {Left} left, {Held} held (first plugin usable after {FirstUsableMs} ms, winner sweep {WinnersMs} ms)",
                timer.ElapsedMilliseconds, arriving.Count, moved.Count, leaving.Count, loadOrder.Plugins.Count,
                firstUsableMs, winnersTimer.ElapsedMilliseconds);
        }
    }

    /// <summary>A copy that failed to open last time, and whose bytes have not changed since — its
    /// error state stands, and the parse is not paid again.</summary>
    private bool StillFailing(ResolvedPlugin plugin)
    {
        (PluginKey, string? Hash) failedAt;
        lock (_lock)
        {
            if (!_failedHashes.TryGetValue(KeyOf(plugin.Key), out failedAt)) return false;
        }
        return failedAt.Hash != null && PluginBinaryHash.OfFile(plugin.Path) == failedAt.Hash;
    }

    /// <summary>
    /// ADR-0001: a copy the index has already seen is *registered* rather than indexed.
    /// Registering is a single <c>registrations</c> row — the rows this plugin's file produced are
    /// already in the file, and the open-time validation has already re-hashed them against the
    /// disk, so a non-null content hash here means "held, and still matching the bytes on disk".
    /// Everything the file has never seen, and everything whose bytes moved (validation dropped
    /// those), falls through and is indexed.
    ///
    /// <para>A tracked plugin never takes the register path, however current its binary: its rows
    /// come from its source tree, which is its truth (ADR-0041/0042) and which the index holds no
    /// hash for. That is why the tree is resolved here rather than inside IndexOnePlugin — the
    /// register/index decision needs the same answer, and asking git twice per plugin is a cost a
    /// 72-plugin load order notices.</para>
    /// </summary>
    private void RegisterOrIndex(LoadOrder loadOrder, IRecordIndex index, PluginMetadata plugin, CancellationToken token)
    {
        var key = plugin.Key;
        var sourceTree = SourceIngest.TreeFor(plugin.Origin, plugin.Path, plugin.Name);
        if (sourceTree == null && index.IndexedContentHash(key) != null)
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "Registering {Plugin} ({RecordCount} records), already indexed and unchanged on disk",
                    plugin.Name, plugin.RecordCount);
            }
            index.Register(key, plugin.Registration);
            // Counted exactly as an indexed plugin is, and for the same reason: Status promises a
            // plugin listed here is wholly queryable, and a registered one is. This is what makes
            // a warm reconcile visibly advance rather than sit at zero until the sweep.
            lock (_lock) _indexed.Add(new IndexedPlugin(plugin.Name, plugin.Origin));
            return;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Indexing {Plugin} ({RecordCount} records)", plugin.Name, plugin.RecordCount);
        }
        var indexTimer = Stopwatch.StartNew();
        try
        {
            // ADR-0036: threads the origin into the index, so the DuckDB row is identified
            // by (origin, plugin) together, not filename alone.
            IndexOnePlugin(loadOrder, index, plugin, loadOrder.GetMod(plugin.Name, plugin.Origin)!, sourceTree, token);
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("Indexed {Plugin} in {ElapsedMs} ms", plugin.Name, indexTimer.ElapsedMilliseconds);
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            // A single plugin with malformed record data (e.g. Mutagen can't parse it) must not
            // abort the whole reconcile — same isolation LoadOrder.Open already gives ImportGetter
            // failures, extended to this later indexing stage (Index() runs in its own DuckDB
            // transaction, so the rollback on throw leaves no partial rows behind).
            _logger.LogWarning(ex, "Failed to index {Plugin}; its records will not be queryable", plugin.Name);
            loadOrder.SetFailure(key, PluginLoadFailure.ReasonFor(ex));
            return;
        }

        lock (_lock)
        {
            // Recorded only once Index() has returned: Status promises a plugin here is wholly
            // queryable, so listing it any earlier would be the partial-visibility lie in a
            // different form.
            _indexed.Add(new IndexedPlugin(plugin.Name, plugin.Origin));
        }
    }

    /// <summary>
    /// Where one plugin's records come from (ADR-0041 amendment, point 2): a tracked
    /// plugin's own source tree, and the binary for everything else. Both branches end in the same
    /// <see cref="IRecordIndex.Index"/> call over the same <c>IModGetter</c> shape, which is what
    /// keeps the read model free of a dialect — see <see cref="SourceIngest"/>'s own doc comment.
    ///
    /// <para><b>The binary is still opened for a tracked plugin, and that is a bounded decision, not
    /// an oversight.</b> <see cref="Plugins.LoadOrder"/> reads the overlay for <i>metadata</i> — masters,
    /// record count — and the write path builds its typed link cache from the same open getter.
    /// "Never consult the binary for a tracked plugin's <i>content</i>" is what this method
    /// establishes, and content is exactly what it redirects. Moving masters/record count onto the
    /// tree as well (the source's root <c>RecordData.json</c> is the mod header's source file, so the
    /// facts are all there) is a real and reasonable further step — it is simply not this one, and it
    /// would reach into <see cref="Plugins.LoadOrder"/>'s mod registry and the save path. Anyone deciding
    /// otherwise should start from this sentence rather than rediscovering the question.</para>
    ///
    /// <para><b>A failed source read degrades to the binary, loudly.</b> The source tree is a file on
    /// disk like any other: MO2, xEdit, a git operation, or the user can mangle or remove it between
    /// two reconciles (root CLAUDE.md's never-assume-exclusive-ownership rule). Dropping the plugin
    /// entirely would be the worse failure, so the ingest falls back — but a fallback nobody is told
    /// about is precisely the hazard, since the user would be reading pre-Track binary content while
    /// believing they were reading their own tracked source. So this records a real
    /// <c>PluginLoadFailure</c> through the load order's own partial-success channel (the same one
    /// surfaced by <c>GET /load-order/status</c>), not merely a log line.</para>
    /// </summary>
    private void IndexOnePlugin(
        LoadOrder loadOrder, IRecordIndex index, PluginMetadata plugin,
        IModGetter binary, string? sourceTree, CancellationToken token)
    {
        if (sourceTree == null)
        {
            index.Index(binary, plugin.Registration, plugin.Key, plugin.Path);
            return;
        }

        try
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Ingesting {Plugin} from its source tree ({Tree})", plugin.Name, sourceTree);
            }
            SourceIngest.Ingest(
                index, ModFolders.Of(plugin.Origin, plugin.Path)!, sourceTree,
                plugin.Registration, plugin.Key, plugin.Path, loadOrder.GameRelease,
                _schemaReflector, _logger, token);
            return;
        }
        catch (OperationCanceledException)
        {
            // The reconcile is being superseded; this is not a source failure and must not be
            // reported as one, nor absorbed into a fallback that would keep working after the cancel.
            throw;
        }
        catch (Exception ex)
        {
            // Deliberately every other exception, not a curated set: the failure modes of reading a
            // whole folder tree through a third-party deserializer are open-ended (malformed JSON, a
            // half-written file, a truncated tree, a schema the pinned serializer cannot read), and a
            // list of the ones seen so far would silently drop the first one that isn't on it back
            // into the caller's "this plugin is unqueryable" branch.
            _logger.LogWarning(ex,
                "Could not ingest {Plugin} from its source tree; falling back to the binary", plugin.Name);
            loadOrder.SetFailure(plugin.Key,
                $"Could not read this plugin's source tree ({PluginLoadFailure.ReasonFor(ex)}). Showing the " +
                "compiled binary instead — edits made since the last compile are not reflected.");
        }

        index.Index(binary, plugin.Registration, plugin.Key, plugin.Path);
    }

    /// <summary>
    /// ADR-0041: the New Plugin gesture — lands in whatever
    /// <paramref name="path"/>/<paramref name="origin"/> the caller
    /// resolved (Mod Management's destination QuickPick — overwrite/, an existing mod, or a freshly
    /// installed mod folder; see <c>PluginEndpoints.CreatePlugin</c>'s doc comment for the full
    /// division of labour). This method's job stops at the boundary: it writes the binary, holds it
    /// as a genuine load-order participant (<see cref="Plugins.LoadOrder.AddCreatedPlugin"/>) and
    /// indexes it. It never touches <c>plugins.txt</c> — Mod Management owns that file
    /// (CONTEXT-MAP.md), and appending the load-order line is the caller's job, done only once this
    /// call (and any Track it triggers) has actually succeeded, so the load order can never name a
    /// file this method didn't finish writing; the snapshot that follows the append corrects the slot.
    /// </summary>
    public PluginResponse CreatePlugin(string name, string path, string origin)
    {
        // #673: this indexes a whole new plugin (index.Index below), so it is a write like any
        // other. _lock alone would not order it against an in-flight edit — the edit path writes
        // through IRecordIndex without holding _lock at all, so the two would still meet on one
        // DuckDB connection. Outside _lock, like every other acquisition here.
        using var _ = WriteGate.Enter();

        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("Plugin name cannot be empty.", nameof(name));
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("Destination path cannot be empty.", nameof(path));
        if (string.IsNullOrWhiteSpace(origin))
            throw new ArgumentException("Origin cannot be empty.", nameof(origin));

        var ext = Path.GetExtension(name);
        if (!ext.Equals(".esp", StringComparison.OrdinalIgnoreCase) &&
            !ext.Equals(".esm", StringComparison.OrdinalIgnoreCase) &&
            !ext.Equals(".esl", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException($"Invalid plugin extension '{ext}'. Must be .esp, .esm, or .esl.", nameof(name));
        }

        lock (_lock)
        {
            var (loadOrder, index) = RequireScopeCore();

            // Never-assume-exclusive-ownership: the destination may be a mod folder nothing has
            // written into yet (a brand-new mod, or overwrite/ before its first file) — Mod
            // Management is expected to have created a real mod folder itself for the "new mod"
            // destination (installMod), but this guards the overwrite/ case and any other caller
            // defensively rather than assuming the folder exists.
            Directory.CreateDirectory(path);

            var filePath = Path.Combine(path, name);
            if (File.Exists(filePath))
                throw new IOException($"Plugin file already exists: {name}");

            var modKey = ModKey.FromFileName(name);
            var mod = ModFactory.Activator(modKey, _gameRelease);
            // #290 (maintainer ruling 2026-08-31): a new plugin defaults to an ESL-flagged ESP,
            // silently — the flag is an ordinary editable header field afterward. Only for a
            // caller-named .esp: an explicit .esl is light by extension already, and an explicit
            // .esm asked for a full master.
            if (Path.GetExtension(name).Equals(".esp", StringComparison.OrdinalIgnoreCase))
            {
                mod.IsSmallMaster = true;
            }
            mod.WriteToBinary(filePath);

            var metadata = loadOrder.AddCreatedPlugin(filePath, origin);
            var openedMod = loadOrder.GetMod(metadata.Name, metadata.Origin)!;
            index.Index(openedMod, metadata.Registration, metadata.Key, metadata.Path);
            _indexed.Add(new IndexedPlugin(metadata.Name, metadata.Origin));
            return PluginResponse.FromMetadata(metadata);
        }
    }

    /// <summary>See <see cref="ILoadOrderMirror.ReindexPlugin(PluginKey)"/>.</summary>
    public Task ReindexPlugin(PluginKey key)
    {
        // #673: taken here, before anything reaches _lock or the index. This runs on the
        // external-change watcher's timer, with no request behind it and nothing else ordering it
        // against an in-flight edit. Reentrant, so the ReingestPluginFromSource branch below taking
        // it again for its own callers costs a recursion count rather than a deadlock.
        //
        // The `using` releases when this method *returns*, not when the returned Task completes,
        // which is correct only because both branches below are fully synchronous (ReindexOne ends
        // in `return Task.CompletedTask`). Introducing a real `await` under either would silently
        // ungate the write: make this method `async` at the same time, so the gate spans the whole
        // of it.
        using var _ = WriteGate.Enter();

        var (metadata, index, gameRelease) = RequireHeldCopy(key);

        // #672: a tracked copy's truth is its source tree, so it is re-derived from there and its
        // binary is never opened — see the interface's own doc comment for why reading the binary
        // here was silently discarding uncommitted edits. Asked once here as a bare "is this
        // tracked" question; the door below resolves the tree it actually reads for itself, so
        // neither has to trust the other's answer about a folder either of them could have lost
        // in between (root CLAUDE.md's never-assume-exclusive-ownership rule).
        if (SourceIngest.TreeFor(metadata.Origin, metadata.Path, metadata.Name) != null)
        {
            ReingestPluginFromSource(key);
            return Task.CompletedTask;
        }

        return ReindexOne(metadata, index, gameRelease);
    }

    /// <summary>
    /// See <see cref="ILoadOrderMirror.ReingestPluginFromSource"/>. The same
    /// <see cref="SourceIngest.Ingest"/> the reconcile's own tracked-plugin branch runs, so a
    /// re-ingest and a first ingest produce the same rows and the same Head state by construction
    /// rather than by agreement.
    ///
    /// <para><b>The whole re-derivation is under <c>_lock</c></b>, unlike the reconcile's own ingest,
    /// which runs unlocked. The difference is when each of them fires: the reconcile builds an index
    /// nothing is querying yet and holds <c>_reconcileGate</c> throughout, whereas this door fires
    /// from the watcher's timer thread against a live index that other mutation doors
    /// (<see cref="ReindexOne"/>, <see cref="UnindexPlugin"/>, <see cref="ApplyFilter"/>) are all
    /// serialized against by this same lock. Being the one live mutation that isn't would put two
    /// writers on one DuckDB connection. The cost is that a <c>Status</c> poll can wait out a
    /// whole-tree deserialize, which is a stall, not a lie.</para>
    ///
    /// <para><b>A failed read is recorded before it is rethrown.</b> This does not degrade to the
    /// binary the way <see cref="IndexOnePlugin"/>'s first ingest does, and the reason is the
    /// difference between the two situations: at first ingest there are no rows, so the binary is
    /// better than nothing; here the index already holds this plugin's source-derived rows, and
    /// overwriting them with compiled content is the exact silent loss #672 exists to stop. But
    /// "never silently" binds either way, so the failure still goes into the load order's own
    /// <see cref="ILoadOrder.LoadFailures"/> (ADR-0026) rather than escaping as a bare exception for
    /// the caller to log and forget.</para>
    /// </summary>
    public void ReingestPluginFromSource(PluginKey key)
    {
        // #673: outside _lock, always. This door is reached both from the watcher's timer (via
        // ReindexPlugin) and directly, so it takes the gate for itself rather than trusting a caller
        // to have taken it; the reentrant gate makes the doubled acquisition free.
        using var _ = WriteGate.Enter();

        var (metadata, index, gameRelease) = RequireHeldCopy(key);
        var sourceTree = SourceIngest.TreeFor(metadata.Origin, metadata.Path, metadata.Name)
            ?? throw new InvalidOperationException(
                $"Plugin '{key.Name}' from '{key.Origin}' has no source tree to re-ingest; it is not tracked.");

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Re-ingesting {Plugin} from its source tree ({Tree})", metadata.Name, sourceTree);
        }

        lock (_lock)
        {
            try
            {
                SourceIngest.Ingest(
                    index, ModFolders.Of(metadata.Origin, metadata.Path)!, sourceTree,
                    metadata.Registration, metadata.Key, metadata.Path, gameRelease, _schemaReflector, _logger);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not re-ingest {Plugin} from its source tree", metadata.Name);
                _loadOrder?.SetFailure(key,
                    $"Could not re-read this plugin's source tree ({PluginLoadFailure.ReasonFor(ex)}). Still " +
                    "showing what was last read from it — the compiled binary is not used for a tracked plugin.");
                throw;
            }

            index.UpdateWinners();
            // Re-derived content can flip filter membership either way.
            ReapplyFilter();
        }
    }

    /// <summary>The copy <paramref name="key"/> names, and the index and release to act on it with —
    /// the one held-and-known gate both re-derivation doors above share.</summary>
    private (PluginMetadata Metadata, IRecordIndex Index, GameRelease GameRelease) RequireHeldCopy(PluginKey key)
    {
        lock (_lock)
        {
            var scope = RequireScopeCore();
            var metadata = scope.LoadOrder.Find(key)
                ?? throw new KeyNotFoundException($"Plugin '{key.Name}' from '{key.Origin}' is not held.");
            return (metadata, scope.Index, _gameRelease);
        }
    }

    private Task ReindexOne(PluginMetadata metadata, IRecordIndex index, GameRelease gameRelease)
    {
        var modKey = ModKey.FromFileName(Path.GetFileName(metadata.Path));
        var modPath = new ModPath(modKey, metadata.Path);
        // Same explicit strings parameters every other deep-parse call site builds.
        using var loaded = _modImporter.Import(
            modPath, gameRelease, LocalizedStrings.ForRead(ModFolders.Of(metadata.Origin, metadata.Path), _loadOrder!.DataFolderPath));

        lock (_lock)
        {
            index.Index(loaded.Getter, metadata.Registration, metadata.Key, metadata.Path);
            index.UpdateWinners();
            // Re-indexed content can flip filter membership either way.
            ReapplyFilter();
        }

        return Task.CompletedTask;
    }

    /// <summary>See <see cref="ILoadOrderMirror.UnindexPlugin"/>.</summary>
    public void UnindexPlugin(PluginKey key)
    {
        // #673: the watcher's timer's other index write — a vanished binary — and gated like its
        // sibling above. Outside _lock, never inside it.
        using var _ = WriteGate.Enter();

        lock (_lock)
        {
            if (_index == null) return;

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "{Plugin} ({Origin}) is gone from disk; removing it from the index", key.Name, key.Origin);
            }
            _index.Unindex(key);
            // A removal moves winners for every FormKey it held, exactly as an re-index does.
            _index.UpdateWinners();
            // Rows that no longer exist cannot match a filter that a stale _filter still lists.
            ReapplyFilter();
        }
    }

    public void SetFilter(string sql) => ApplyFilter(sql);
    public void ClearFilter() => ApplyFilter(null);

    private void ApplyFilter(string? sql)
    {
        // #673: materializing _filter is an index write, and the filter box is live while an edit
        // runs — so SetFilter/ClearFilter racing an in-flight edit is the ordinary case, not an
        // exotic one. Gated here, at the public doors' one shared implementation.
        //
        // ReapplyFilter is deliberately *not* gated: every one of its call sites is already inside
        // a gated write (the edit path, the read-time self-heal, this class's own mutation doors) or
        // inside the reconcile, which holds _reconcileGate instead. Taking the gate there would add
        // nothing those callers do not already have, and would newly make a reconcile wait on an
        // edit.
        using var _ = WriteGate.Enter();

        lock (_lock)
        {
            var (loadOrder, index) = RequireScopeCore();
            index.SetFilter(sql);
            loadOrder.FilterSql = sql;
        }
    }

    // The one place `_filter` gets re-run against current index state. `_lock` is reentrant,
    // so every mutation path calls this from inside the same lock scope it already holds around its
    // Index/UpdateWinners calls, rather than dropping and retaking it.
    public void ReapplyFilter()
    {
        lock (_lock)
        {
            if (_loadOrder?.FilterSql is not { } sql || _index is null) return;
            try
            {
                _index.SetFilter(sql);
            }
            catch (System.Data.Common.DbException ex)
            {
                // The write this followed (a source file, a re-indexed binary) is already durable by
                // the time every one of this method's call sites reaches it — propagating here would
                // 500 a gesture that actually succeeded, over a table that is only ever a filtered
                // *view* of otherwise-correct data. Degrades to serving the stale `_filter` rather
                // than losing the write; the warning is what makes that degradation observable instead
                // of a silent lie.
                _logger.LogWarning(ex,
                    "Could not re-materialize the active filter ({Error}); filtered listings may be " +
                    "stale until the filter is reapplied", ex.Message);
            }
        }
    }

    public void Close()
    {
        // Cancels an in-flight reconcile and waits for it to stop *before* disposing anything —
        // the teardown half of the cancellation. Disposing while the loop still holds the
        // index is a native crash, not a catchable one.
        EnterExclusive();
        try { lock (_lock) DisposeCurrent(); }
        finally { ExitExclusive(); }
    }

    public void Dispose()
    {
        // Guarded because Dispose owns a semaphore as well as the load order: a second call would
        // otherwise wait on a disposed gate. Double disposal is a supported call pattern here
        // (Dispose_CalledTwice_DoesNotThrow), not a defensive assumption.
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
        }

        EnterExclusive();
        try { lock (_lock) DisposeCurrent(); }
        finally { ExitExclusive(); }
        _reconcileGate.Dispose();
    }

    private void DisposeCurrent()
    {
        _loadOrder?.Dispose();
        _loadOrder = null;
        _index?.Dispose();
        _index = null;
        _indexed.Clear();
        _failedHashes.Clear();
        _conflictsComputed = false;
        _plannedCount = 0;
    }
}
