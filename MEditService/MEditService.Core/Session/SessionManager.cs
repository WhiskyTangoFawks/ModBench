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
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Session;

public sealed class SessionManager(
    IRecordIndexFactory repositoryFactory,
    ILogger<SessionManager>? logger = null,
    IModImporter? modImporter = null,
    ISchemaReflector? schemaReflector = null) : ISessionManager, IDisposable
{
    private readonly Lock _lock = new();
    private readonly ILogger<SessionManager> _logger = logger ?? NullLogger<SessionManager>.Instance;
    private readonly IRecordIndexFactory _repositoryFactory = repositoryFactory;
    private readonly IModImporter _modImporter = modImporter ?? new DefaultModImporter();
    // #463: the same reflector ReconcileHeadStructurally's SourceRecordType.Resolve needs for a
    // container's Head-only deletion — DI already registers ISchemaReflector as its own singleton
    // (Program.cs), so this is a direct constructor parameter rather than routed through
    // IRecordIndexFactory, which has no other reason to carry it.
    private readonly ISchemaReflector _schemaReflector = schemaReflector ?? new SchemaReflector();
    private GameSession? _session;
    private IRecordIndex? _repository;
    // #274: the load's own progress. Guarded by _lock like _session/_repository — written by the
    // loading thread as each plugin lands, read by whoever asks for Status meanwhile.
    private readonly List<IndexedPlugin> _indexed = [];
    private bool _conflictsComputed;

    // #274: at most one load or teardown at a time, and an in-flight load stops promptly when
    // another arrives. Two mechanisms, because one is not enough: the token *asks* the loop to stop,
    // and the gate waits until it actually has. Cancelling without draining is the dangerous half —
    // it would let a teardown dispose the DuckDB connection while the loop is still writing to it,
    // which is a native crash rather than an exception, taking the backend and the loaded session with
    // it. Deliberately not _lock: the loading thread takes _lock briefly on every plugin, so a
    // waiter holding it could never be signalled.
    private readonly SemaphoreSlim _loadGate = new(1, 1);
    private CancellationTokenSource? _loadCancellation;
    private bool _disposed;

    /// <summary>Cancels any in-flight load, waits for it to stop, and takes the exclusive right to
    /// load or tear down. Always paired with <see cref="ExitExclusive"/> in a finally.</summary>
    private void EnterExclusive()
    {
        // Cancel and dispose both happen under _lock, so a token can never be cancelled after it has
        // been disposed.
        lock (_lock) _loadCancellation?.Cancel();
        _loadGate.Wait();
    }

    private void ExitExclusive() => _loadGate.Release();

    private const string NoSessionMessage = "No session loaded.";

    private GameRelease _gameRelease;

    public IGameSession? Session { get { lock (_lock) return _session; } }
    public IRecordReads? Repository { get { lock (_lock) return _repository; } }
    public IRecordIndex? Index { get { lock (_lock) return _repository; } }

    /// <summary>
    /// What the session can honestly say about itself right now (#274 / ADR-0035) — the read behind
    /// <c>GET /session/status</c>. Assembled from live state rather than cached, so it cannot drift
    /// from the load it describes; failures come straight off the session's own list rather than
    /// being copied into a second place that could disagree with it.
    /// </summary>
    public SessionStatus Status
    {
        get
        {
            lock (_lock)
            {
                if (_session is null) return SessionStatus.None;
                var state = _conflictsComputed ? SessionState.Ready : SessionState.Loading;
                return new SessionStatus(
                    state,
                    _session.PlannedPluginCount,
                    [.. _indexed],
                    _conflictsComputed,
                    _session.LoadFailures);
            }
        }
    }

    public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease)
    {
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Session load starting. DataFolder={DataFolder} PluginsTxt={PluginsTxt} Game={Game}",
                dataFolderPath, pluginsTxtPath, gameRelease);
        }

        RunLoad(
            gameRelease,
            logger => new GameSession(dataFolderPath, pluginsTxtPath, gameRelease, logger),
            "Creating game session (reading plugins list and opening binary overlays)",
            "Session load complete", "Session load failed");
    }

    // #269 / ADR-0036: real (MO2-backed) session loads carry each plugin's origin through to
    // GameSession — and since #270 / ADR-0035, its participation too.
    public void LoadExplicit(string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease) =>
        LoadExplicitCore(gameDirectory, plugins.Count, gameRelease,
            logger => GameSession.LoadExplicit(gameDirectory, plugins, gameRelease, logger));

    private void LoadExplicitCore(string gameDirectory, int pluginCount, GameRelease gameRelease, Func<ILogger?, GameSession> buildSession)
    {
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Explicit session load starting. GameDir={GameDir} Plugins={Count} Game={Game}",
                gameDirectory, pluginCount, gameRelease);
        }

        // No plugins.txt for an explicit session; the game directory is the implicit-master root.
        RunLoad(
            gameRelease, buildSession,
            "Creating explicit game session from scattered paths",
            "Explicit session load complete", "Explicit session load failed");
    }

    /// <summary>
    /// The one load path: take the exclusive right, arm a cancellation token, build the session,
    /// index it progressively, and release — the two public entry points differ only in how the
    /// session is built and what they call it in the log.
    /// <para>
    /// Unified when #274's mutation review found the teardown-on-failure branch covered on the
    /// explicit path and uncovered on the other: the same lifecycle written twice is one place for a
    /// cancellation or disposal bug to hide, and the interesting failure modes (cancel mid-load,
    /// supersede, drain before dispose) are only ever exercised through one of them.
    /// </para>
    /// </summary>
    private void RunLoad(
        GameRelease gameRelease,
        Func<ILogger?, GameSession> buildSession, string buildingMessage, string completeMessage, string failedMessage)
    {
        EnterExclusive();
        try
        {
            var token = BeginLoad();

            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("{Step}", buildingMessage);
            }
            var session = buildSession(_logger);
            // IndexAndStore tears down a session it has already published; this covers the window
            // before that, where the failure belongs to nobody else.
            //
            // #400: session.Dispose() here has no unit-observable effect — GameSession is sealed
            // with no injectable importer (OpenAll/Open call ModFactory.ImportGetter directly), so a
            // test can neither substitute a spy nor prove the OS file handles it opened were
            // released (confirmed empirically: opening the same plugin file twice through
            // ModFactory.ImportGetter without disposing the first does not throw — there is no
            // exclusive lock to probe from outside). Same category of gap as GameSession.Dispose()'s
            // own per-mod loop, which says as much directly. Accepted as an invariant rather than
            // tested: the call stays because leaking every mod overlay a build opened on a
            // pre-publish failure (a bad GameRelease, a repository that fails to initialize) would
            // be a real leak, just one this seam cannot pin with a red/green test.
            try { IndexAndStore(session, gameRelease, token); }
            catch { session.Dispose(); throw; }
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("{Step}", completeMessage);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "{Step}", failedMessage);
            throw;
        }
        finally
        {
            EndLoad();
            ExitExclusive();
        }
    }

    /// <summary>Drops the previous session and arms a fresh cancellation token for this load. Called
    /// with the exclusive right held, so no other load can be in flight.</summary>
    private CancellationToken BeginLoad()
    {
        var cts = new CancellationTokenSource();
        lock (_lock)
        {
            DisposeCurrentSession();
            _loadCancellation = cts;
        }
        return cts.Token;
    }

    private void EndLoad()
    {
        lock (_lock)
        {
            var cts = _loadCancellation;
            _loadCancellation = null;
            cts?.Dispose();
        }
    }

    // Indexes the session's plugins into a fresh repository and computes winners, publishing it as
    // the single active session (ADR-0015) *before* the indexing loop rather than after it (#274 /
    // ADR-0035).
    //
    // Publishing first is what makes the load progressive: each plugin's records become queryable at
    // the moment that plugin is indexed, instead of the whole load order being unreachable until the
    // slowest plugin has landed. The trade it makes is that a published session is briefly
    // incomplete, which is why the load reports its own state — a caller must be able to tell "no
    // conflicts" from "not looked yet" (that reporting is Slice 7's `Status`).
    //
    // Deliberately NOT called under _lock: holding it across the loop is exactly what made every
    // read wait for the whole load. The lock now covers only the publish/teardown transitions.
    private void IndexAndStore(GameSession session, GameRelease gameRelease, CancellationToken token)
    {
        _logger.LogDebug("Initializing DuckDB record repository");
        var createTimer = Stopwatch.StartNew();
        // #585/#586 / ADR-0001: the Data folder is what gives the index a home — one persistent file
        // per game install, so this load finds whatever the last one left there.
        var repository = _repositoryFactory.Create(gameRelease, session.DataFolderPath);
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("DuckDB record repository initialized in {ElapsedMs} ms", createTimer.ElapsedMilliseconds);
        }

        lock (_lock)
        {
            _indexed.Clear();
            _conflictsComputed = false;
            _session = session;
            _repository = repository;
            _gameRelease = gameRelease;
        }

        try
        {
            IndexProgressively(session, repository, token);
        }
        catch
        {
            // Anything that escapes the loop — a cancellation, or a failure the per-plugin handler
            // did not absorb — leaves a session that is published but incomplete, and an incomplete
            // session must not survive as if it were whole. Tearing it down here (rather than
            // leaving it to the caller) is what makes "no partially-indexed session behind" true for
            // every exit path, not just the cancelling one. Safe to dispose the published pair: the
            // exclusive right is held, so nothing else can have replaced it.
            lock (_lock) DisposeCurrentSession();
            throw;
        }
    }

    private void IndexProgressively(GameSession session, IRecordIndex repository, CancellationToken token)
    {
        // #113: two numbers ADR-0035 makes distinct — time to the first queryable plugin (the tree
        // becomes usable) and time to the winner sweep completing (the session is fully loaded).
        // Measured here rather than client-side, where the 500 ms status poll caps the resolution.
        var loadTimer = Stopwatch.StartNew();
        long? firstUsableMs = null;

        // #274: open and index one plugin at a time. Opening the whole load order first cost the
        // same total time but made every plugin wait on the slowest one before any of them could
        // be indexed, and buried each open failure until the end.
        foreach (var plugin in session.OpenAll())
        {
            // At the top of each plugin rather than mid-plugin: a plugin is indexed in one
            // transaction, and abandoning it partway would either roll back work already paid for or
            // leave the half-written state this ticket exists to prevent. The cost of the coarser
            // check is at most one plugin's indexing after the cancel.
            token.ThrowIfCancellationRequested();

            var mod = session.GetMod(plugin.Name, plugin.Origin)!;
            var key = new PluginKey(plugin.Name, plugin.Origin);

            // #586 / ADR-0001: loading a session the index has already seen *registers* its plugins
            // rather than indexing them. Registering is a single `plugins` row — the rows this
            // plugin's file produced are already in the file, and the open-time validation has
            // already re-hashed them against the disk, so a non-null content hash here means "held,
            // and still matching the bytes on disk". Everything the file has never seen, and
            // everything whose bytes moved (validation dropped those), falls through and is indexed.
            //
            // A tracked plugin never takes this path, however current its binary: its rows come from
            // its source tree, which is its truth (ADR-0041/0042) and which the index holds no hash
            // for. That is why the tree is resolved here rather than inside IndexOnePlugin, which is
            // where it used to live — the register/index decision needs the same answer, and asking
            // git twice per plugin is a cost a 72-plugin load order notices.
            var sourceTree = SourceIngest.TreeFor(plugin.Origin, plugin.Path, plugin.Name);
            if (sourceTree == null && repository.IndexedContentHash(key) != null)
            {
                if (_logger.IsEnabled(LogLevel.Information))
                {
                    _logger.LogInformation(
                        "Registering {Plugin} ({RecordCount} records), already indexed and unchanged on disk",
                        plugin.Name, plugin.RecordCount);
                }
                repository.Register(key, plugin.LoadOrderIndex, plugin.Participates);
                // Counted exactly as an indexed plugin is, and for the same reason: Status promises a
                // plugin listed here is wholly queryable, and a registered one is. This is what makes
                // a warm launch visibly advance rather than sit at zero until the sweep (#586 AC4).
                lock (_lock) _indexed.Add(new IndexedPlugin(plugin.Name, plugin.Origin));
                firstUsableMs ??= loadTimer.ElapsedMilliseconds;
                continue;
            }

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Indexing {Plugin} ({RecordCount} records)", plugin.Name, plugin.RecordCount);
            }
            var indexTimer = Stopwatch.StartNew();
            try
            {
                // #271 / ADR-0036: threads the origin GameSession already resolved (#269) into the
                // index, so the DuckDB row is identified by (origin, plugin) together, not filename
                // alone.
                IndexOnePlugin(session, repository, plugin, key, mod, sourceTree, token);
                if (_logger.IsEnabled(LogLevel.Debug))
                {
                    _logger.LogDebug("Indexed {Plugin} in {ElapsedMs} ms", plugin.Name, indexTimer.ElapsedMilliseconds);
                }
            }
            catch (Exception ex)
            {
                // A single plugin with malformed record data (e.g. Mutagen can't parse it) must not
                // abort the whole load order — same isolation GameSession already gives ImportGetter
                // failures, extended to this later indexing stage (Index() runs in its own DuckDB
                // transaction, so the rollback on throw leaves no partial rows behind).
                _logger.LogWarning(ex, "Failed to index {Plugin}; its records will not be queryable this session", plugin.Name);
                session.RecordIndexFailure(plugin.Name, PluginLoadFailure.ReasonFor(ex));
                continue;
            }

            // #452 retires #427 Epic B′'s rediscovery sweep, which used to run here. It existed only to
            // correct a binary-seeded ingest: Index() knew the binary alone, so a record created but
            // never compiled had no row to seed from and had to be swept back in. IndexOnePlugin above
            // now reads the source tree itself, where that record is simply present — the sweep has
            // nothing left to discover, and the class is deleted rather than disabled (AC4).

            lock (_lock)
            {
                // Recorded only once Index() has returned: Status promises a plugin here is wholly
                // queryable, so listing it any earlier would be the partial-visibility lie in a
                // different form.
                _indexed.Add(new IndexedPlugin(plugin.Name, plugin.Origin));
            }
            firstUsableMs ??= loadTimer.ElapsedMilliseconds;
        }

        // #274: reported after the loop, not before it — the count is not knowable until the load
        // order has been walked, because opening is now what discovers it.
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Game session indexed. {Count} plugin(s) loaded: {Names}",
                session.Plugins.Count, string.Join(", ", session.Plugins.Select(p => p.Name)));
        }

        // The whole-set sweep, and the moment conflict information becomes correct: a plugin that
        // arrived earlier was browsable but its winner state was not yet decided (ADR-0035).
        _logger.LogDebug("Computing winners");
        var winnersTimer = Stopwatch.StartNew();
        repository.UpdateWinners();
        lock (_lock) _conflictsComputed = true;

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Session fully loaded in {TotalMs} ms (first plugin usable after {FirstUsableMs} ms, winner sweep {WinnersMs} ms)",
                loadTimer.ElapsedMilliseconds, firstUsableMs, winnersTimer.ElapsedMilliseconds);
        }
    }

    /// <summary>
    /// Where one plugin's records come from (#452 / ADR-0041's #444 amendment, point 2): a tracked
    /// plugin's own source tree, and the binary for everything else. Both branches end in the same
    /// <see cref="IRecordIndex.Index"/> call over the same <c>IModGetter</c> shape, which is what
    /// keeps the read model free of a dialect — see <see cref="SourceIngest"/>'s own doc comment.
    ///
    /// <para><b>The binary is still opened for a tracked plugin, and that is a bounded decision, not
    /// an oversight.</b> <see cref="GameSession"/> reads the overlay for <i>metadata</i> — masters,
    /// record count — and the write path builds its typed link cache from the same open getter.
    /// "Never consult the binary for a tracked plugin's <i>content</i>" is what this method
    /// establishes, and content is exactly what it redirects. Moving masters/record count onto the
    /// tree as well (the source's root <c>RecordData.json</c> is the mod header's source file, so the
    /// facts are all there) is a real and reasonable further step — it is simply not this one, and it
    /// would reach into <see cref="GameSession"/>'s mod registry and the save path. Anyone deciding
    /// otherwise should start from this sentence rather than rediscovering the question.</para>
    ///
    /// <para><b>A failed source read degrades to the binary, loudly.</b> The source tree is a file on
    /// disk like any other: MO2, xEdit, a git operation, or the user can mangle or remove it between
    /// two session loads (root CLAUDE.md's never-assume-exclusive-ownership rule). Dropping the plugin
    /// entirely would be the worse failure, so the load falls back — but a fallback nobody is told
    /// about is precisely the hazard, since the user would be reading pre-Track binary content while
    /// believing they were reading their own tracked source. So this records a real
    /// <c>PluginLoadFailure</c> through the session's own partial-success channel (the same one
    /// surfaced by <c>GET /session/status</c>), not merely a log line.</para>
    /// </summary>
    private void IndexOnePlugin(
        GameSession session, IRecordIndex repository, PluginMetadata plugin, PluginKey key,
        IModGetter binary, string? sourceTree, CancellationToken token)
    {
        if (sourceTree == null)
        {
            repository.Index(binary, plugin.LoadOrderIndex, plugin.Participates, key, plugin.Path);
            return;
        }

        try
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Ingesting {Plugin} from its source tree ({Tree})", plugin.Name, sourceTree);
            }
            SourceIngest.Ingest(
                repository, ModFolders.Of(plugin.Origin, plugin.Path)!, sourceTree,
                plugin.LoadOrderIndex, plugin.Participates, key, plugin.Path, session.GameRelease,
                _schemaReflector, _logger, token);
            return;
        }
        catch (OperationCanceledException)
        {
            // The load is being torn down; this is not a source failure and must not be reported as
            // one, nor absorbed into a fallback that would keep working after the cancel.
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
            session.RecordIndexFailure(plugin.Name,
                $"Could not read this plugin's source tree ({PluginLoadFailure.ReasonFor(ex)}). Showing the " +
                "compiled binary instead — edits made since the last compile are not reflected.");
        }

        repository.Index(binary, plugin.LoadOrderIndex, plugin.Participates, key, plugin.Path);
    }

    /// <summary>
    /// #288 / ADR-0041: the New Plugin gesture, re-scoped from writing straight into the game's Data
    /// folder to landing in whatever <paramref name="path"/>/<paramref name="origin"/> the caller
    /// resolved (Mod Management's destination QuickPick — overwrite/, an existing mod, or a freshly
    /// installed mod folder; see <c>PluginEndpoints.CreatePlugin</c>'s doc comment for the full
    /// division of labour). This method's job stops at the session boundary: it writes the binary,
    /// opens it as a genuine load-order participant (<see cref="GameSession.AddCreatedPlugin"/>) and
    /// indexes it, the same three steps <see cref="LoadUnlistedPlugin"/> already does for a plugin
    /// opened mid-session. It never touches <c>plugins.txt</c> — Mod Management owns that file
    /// (CONTEXT-MAP.md), and appending the load-order line is now the caller's job, done only once
    /// this call (and any Track it triggers) has actually succeeded, so the load order can never
    /// name a file this method didn't finish writing.
    /// </summary>
    public PluginResponse CreatePlugin(string name, string path, string origin)
    {
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
            if (_session is null)
                throw new InvalidOperationException(NoSessionMessage);

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
            mod.WriteToBinary(filePath);

            var metadata = _session.AddCreatedPlugin(filePath, origin);
            var openedMod = _session.GetMod(metadata.Name, metadata.Origin)!;
            _repository!.Index(openedMod, metadata.LoadOrderIndex, metadata.Participates,
                new PluginKey(metadata.Name, metadata.Origin), metadata.Path);
            return PluginResponse.FromMetadata(metadata);
        }
    }

    public PluginResponse LoadUnlistedPlugin(string path, string origin)
    {
        if (!File.Exists(path))
            throw new FileNotFoundException($"Plugin file not found: {path}", path);

        lock (_lock)
        {
            if (_session is null)
                throw new InvalidOperationException(NoSessionMessage);

            var name = Path.GetFileName(path);
            // It shares the load-order slot of the copy that shadows it, so the two land adjacent
            // in the compare grid (columns are ordered by this index). A file the load order names
            // nowhere has nothing to sit beside, so it sorts after everything the session holds.
            var loadOrderIndex = _session.Plugins
                .Where(p => p.InLoadOrder && p.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                .Select(p => p.LoadOrderIndex)
                // DefaultIfEmpty's argument is evaluated eagerly, so the fallback is computed
                // defensively: Plugins is empty when every load-order plugin failed to open, and a
                // Max() throw there would surface as a misleading 503.
                .DefaultIfEmpty(_session.Plugins.Count == 0 ? 0 : _session.Plugins.Max(p => p.LoadOrderIndex) + 1)
                .First();

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Loading unlisted plugin {Name} from {Origin} at load-order slot {Index}", name, origin, loadOrderIndex);
            }
            var metadata = _session.AddUnlistedPlugin(path, origin, loadOrderIndex);
            var mod = _session.GetMod(metadata.Name, metadata.Origin)!;

            // No UpdateWinners: a non-participating plugin is excluded from the winner sweep by the
            // `plugins` join, so nothing already computed can change. That is the whole reason
            // ADR-0035 lets these arrive lazily while load-order plugins must load together.
            _repository!.Index(mod, metadata.LoadOrderIndex, metadata.Participates,
                new PluginKey(metadata.Name, metadata.Origin), metadata.Path);
            // #422: this plugin's own records can newly (or no longer) match an active filter.
            ReapplyFilter();
            return PluginResponse.FromMetadata(metadata);
        }
    }

    public void UnloadUnlistedPlugin(string plugin, string origin)
    {
        lock (_lock)
        {
            if (_session is null)
                throw new InvalidOperationException(NoSessionMessage);

            // Session first: it owns the membership check (load-order members are refused there),
            // so the index is only touched for a copy that was really unlisted and really open.
            if (!_session.RemoveUnlistedPlugin(plugin, origin))
                throw new KeyNotFoundException($"No unlisted plugin '{plugin}' from origin '{origin}' is loaded.");

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Unloading unlisted plugin {Plugin} from {Origin}", plugin, origin);
            }
            // #582 / ADR-0001: an unload is a session change, not a file change — the registration
            // goes, the rows stay for the next load of this copy. Unindex is the file-gone verb.
            _repository!.Unregister(new PluginKey(plugin, origin));
        }
    }

    public PluginResponse RereadPlugin(string plugin, string newPath, string newOrigin)
    {
        if (string.IsNullOrWhiteSpace(newPath))
            throw new ArgumentException("A re-read needs the path of the copy to read.", nameof(newPath));
        if (string.IsNullOrWhiteSpace(newOrigin))
            throw new ArgumentException("A re-read needs the origin the new copy was resolved from.", nameof(newOrigin));
        // Checked here rather than left to Mutagen: this is the ordinary case (the user re-read
        // after the file moved again), and it must be a clean refusal that touches nothing.
        if (!File.Exists(newPath))
            throw new FileNotFoundException($"Plugin file not found: {newPath}", newPath);

        // One lock for the whole check-and-act, deliberately — see below. `_lock` is reentrant, so
        // RequirePlugin taking it again inside is free.
        lock (_lock)
        {
            // Refused, never queued behind the load and *never* EnterExclusive(): that call cancels
            // whatever load is in flight, so joining the gate would let a re-read destroy a load the
            // user is sitting and watching. The indexing loop also writes to the very repository
            // this would unindex from. The caller retries once the load has landed; the endpoint
            // answers 409. Refused for the whole load, including the window before the partial
            // session is published: a re-read is not answerable against a load order still being
            // assembled, and "there is no session yet" would be a misleading way to say so.
            //
            // This check and the mutation below must share one lock acquisition. Split across two,
            // a Load/LoadExplicit landing in the gap runs BeginLoad() → DisposeCurrentSession(),
            // nulling _session and disposing _repository — so the mutation would dereference a null
            // session and write to a disposed DuckDB connection, surfacing as a 500 and a touched
            // native resource exactly where this comment promises a clean 409. Unload() is the same
            // hazard without even setting _loadCancellation, so the check alone could never have
            // covered it. Every other gated mutation in this file holds the lock across the whole
            // check-and-act (LoadUnlistedPlugin, UnloadUnlistedPlugin); this now does too, and
            // holding it across an open-plus-index is precisely what LoadUnlistedPlugin already
            // does. (#279 review)
            if (_loadCancellation is not null)
                throw new SessionBusyException("A session load is still in flight; re-read this plugin once it has finished.");

            var (previous, repository, _) = RequirePlugin(plugin);

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Re-reading {Plugin}: {OldOrigin} → {NewOrigin}", plugin, previous.Origin, newOrigin);
            }

            // Rebind first — it opens the new file, which is the failure-prone half, and it leaves
            // the session untouched if that open throws. RebindPlugin still opens the binary itself
            // (metadata — masters, record count — comes from the overlay for every plugin, tracked
            // or not; IndexOnePlugin's own doc comment states this is bounded to *content*).
            var metadata = _session!.RebindPlugin(previous, newPath, newOrigin);

            repository.Unindex(new PluginKey(previous.Name, previous.Origin));
            var mod = _session.GetMod(metadata.Name, metadata.Origin)!;
            // #356: routed through the same choke point an ordinary session load uses, rather than
            // repository.Index(mod, ...) directly — a re-read onto a tracked origin must ingest that
            // origin's source tree, exactly as IndexOnePlugin already decides for every other plugin
            // this session opens. Two ingestion paths for one "which copy backs this row" question
            // is exactly the drift this method exists to close, not something to reintroduce here.
            IndexOnePlugin(_session, repository, metadata, new PluginKey(metadata.Name, metadata.Origin), mod,
                SourceIngest.TreeFor(metadata.Origin, metadata.Path, metadata.Name), CancellationToken.None);
            // AC7: the whole-set sweep, so winner status and conflict badges describe the new file.
            repository.UpdateWinners();
            // #422: the reread changed record content, which can flip filter membership either way.
            ReapplyFilter();

            return PluginResponse.FromMetadata(metadata);
        }
    }

    // #97 / ADR-0035 § Live mutation: flips a load-order member's participation flag (the
    // plugins.txt `*` prefix) in the running session — SQL-only, no re-read, no re-index. Mirrors
    // RereadPlugin's lock/busy-guard shape exactly: the check-and-act shares one lock acquisition
    // (see that method's own comment for why splitting it is a crash-class hazard), and a load in
    // flight refuses with the same SessionBusyException rather than racing the loading thread's own
    // writes to this repository.
    public PluginResponse SetPluginParticipation(string plugin, bool participates)
    {
        lock (_lock)
        {
            if (_loadCancellation is not null)
            {
                throw new SessionBusyException(
                    "A session load is still in flight; change this plugin's participation once it has finished.");
            }

            var (previous, repository, _) = RequirePlugin(plugin);

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Setting {Plugin} participation: {Participates}", plugin, participates);
            }

            var metadata = _session!.SetParticipation(previous, participates);
            repository.SetPluginParticipation(new PluginKey(metadata.Name, metadata.Origin), participates);
            // AC2/AC6: the whole-set sweep, so winner status, conflict badges and any open record
            // editor describe the new participation — the same re-sweep RereadPlugin's own AC7
            // comment cites, for the same reason.
            repository.UpdateWinners();
            // #422: a plugin that stops participating stops contributing is_winner rows a filter
            // referencing that column could match — same reasoning as every other mutation path.
            ReapplyFilter();

            return PluginResponse.FromMetadata(metadata);
        }
    }

    public Task ReindexPlugins(IReadOnlyList<string> plugins)
    {
        var loaded = new List<(PluginMetadata Metadata, IRecordIndex Repository, ILoadedMod Loaded)>(plugins.Count);
        try
        {
            foreach (var plugin in plugins)
            {
                var (metadata, repository, gameRelease) = RequirePlugin(plugin);
                var modKey = ModKey.FromFileName(Path.GetFileName(metadata.Path));
                var modPath = new ModPath(modKey, metadata.Path);
                // #515: same explicit strings parameters every other deep-parse call site now builds.
                var param = LocalizedStrings.ForRead(ModFolders.Of(metadata.Origin, metadata.Path), _session!.DataFolderPath);
                loaded.Add((metadata, repository, _modImporter.Import(modPath, gameRelease, param)));
            }

            lock (_lock)
            {
                foreach (var (metadata, repository, item) in loaded)
                    repository.Index(item.Getter, metadata.LoadOrderIndex, metadata.Participates,
                        new PluginKey(metadata.Name, metadata.Origin), metadata.Path);
                if (loaded.Count > 0)
                {
                    loaded[0].Repository.UpdateWinners();
                    // #422: re-indexed content can flip filter membership either way.
                    ReapplyFilter();
                }
            }
        }
        finally
        {
            foreach (var (_, _, item) in loaded)
                item.Dispose();
        }

        return Task.CompletedTask;
    }

    /// <summary>See <see cref="ISessionManager.ReindexPlugin(PluginKey)"/>.</summary>
    public Task ReindexPlugin(PluginKey key)
    {
        PluginMetadata metadata;
        IRecordIndex repository;
        GameRelease gameRelease;
        lock (_lock)
        {
            if (_session == null) throw new InvalidOperationException(NoSessionMessage);
            metadata = _session.Plugins.FirstOrDefault(p =>
                    string.Equals(p.Name, key.Name, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(p.Origin, key.Origin, StringComparison.OrdinalIgnoreCase))
                ?? throw new KeyNotFoundException($"Plugin '{key.Name}' from '{key.Origin}' not found in session.");
            (repository, gameRelease) = (_repository!, _gameRelease);
        }

        return ReindexOne(metadata, repository, gameRelease);
    }

    public Task ReindexPlugin(string plugin)
    {
        var (metadata, repository, gameRelease) = RequirePlugin(plugin);
        return ReindexOne(metadata, repository, gameRelease);
    }

    private Task ReindexOne(PluginMetadata metadata, IRecordIndex repository, GameRelease gameRelease)
    {
        var modKey = ModKey.FromFileName(Path.GetFileName(metadata.Path));
        var modPath = new ModPath(modKey, metadata.Path);
        // #515: same explicit strings parameters every other deep-parse call site now builds.
        using var loaded = _modImporter.Import(
            modPath, gameRelease, LocalizedStrings.ForRead(ModFolders.Of(metadata.Origin, metadata.Path), _session!.DataFolderPath));

        lock (_lock)
        {
            repository.Index(loaded.Getter, metadata.LoadOrderIndex, metadata.Participates,
                new PluginKey(metadata.Name, metadata.Origin), metadata.Path);
            repository.UpdateWinners();
            // #422: re-indexed content can flip filter membership either way.
            ReapplyFilter();
        }

        return Task.CompletedTask;
    }

    /// <summary>See <see cref="ISessionManager.UnindexPlugin"/>.</summary>
    public void UnindexPlugin(PluginKey key)
    {
        lock (_lock)
        {
            if (_repository == null) return;

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "{Plugin} ({Origin}) is gone from disk; removing it from the index", key.Name, key.Origin);
            }
            _repository.Unindex(key);
            // A removal moves winners for every FormKey it held, exactly as an re-index does.
            _repository.UpdateWinners();
            // #422: rows that no longer exist cannot match a filter that a stale _filter still lists.
            ReapplyFilter();
        }
    }

    private (PluginMetadata Metadata, IRecordIndex Repository, GameRelease GameRelease) RequirePlugin(string plugin)
    {
        lock (_lock)
        {
            if (_session == null)
                throw new InvalidOperationException(NoSessionMessage);
            // #34: load-order members only, for the same reason PluginOriginResolver scopes that
            // way — this resolves the *file a write lands on* (SavePlugin/PreparePluginSave/
            // ReindexPlugin all route through here), and a plugin outside the load order is
            // read-only. Without the scope a save could pick a shadowed copy's path off a bare
            // filename and write to a file the game does not load.
            var meta = _session.Plugins.FirstOrDefault(p =>
                p.InLoadOrder && string.Equals(p.Name, plugin, StringComparison.OrdinalIgnoreCase)) ?? throw new KeyNotFoundException($"Plugin '{plugin}' not found in session.");
            return (meta, _repository!, _gameRelease);
        }
    }

    public void SetFilter(string sql) => ApplyFilter(sql);
    public void ClearFilter() => ApplyFilter(null);

    private void ApplyFilter(string? sql)
    {
        lock (_lock)
        {
            if (_session is null)
                throw new InvalidOperationException(NoSessionMessage);
            _repository!.SetFilter(sql);
            _session.FilterSql = sql;
        }
    }

    // #422: the one place `_filter` gets re-run against current index state. `_lock` is reentrant
    // (see RereadPlugin's own comment), so every mutation path below calls this from inside the same
    // lock scope it already holds around its Index/UpdateWinners calls, rather than dropping and
    // retaking it.
    public void ReapplyFilter()
    {
        lock (_lock)
        {
            if (_session?.FilterSql is not { } sql || _repository is null) return;
            try
            {
                _repository.SetFilter(sql);
            }
            catch (System.Data.Common.DbException ex)
            {
                // The write this followed (a source file, a re-indexed binary) is already durable by
                // the time every one of this method's 8 call sites reaches it — propagating here would
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

    public void Unload()
    {
        // Cancels an in-flight load and waits for it to stop *before* disposing anything — the
        // teardown half of #274's cancellation. Disposing while the loop still holds the repository
        // is a native crash, not a catchable one.
        EnterExclusive();
        try { lock (_lock) DisposeCurrentSession(); }
        finally { ExitExclusive(); }
    }

    public void Dispose()
    {
        // Guarded because Dispose now owns a semaphore as well as the session: a second call would
        // otherwise wait on a disposed gate. Double disposal is a supported call pattern here
        // (Dispose_CalledTwice_DoesNotThrow), not a defensive assumption.
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
        }

        EnterExclusive();
        try { lock (_lock) DisposeCurrentSession(); }
        finally { ExitExclusive(); }
        _loadGate.Dispose();
    }

    private void DisposeCurrentSession()
    {
        _session?.Dispose();
        _session = null;
        _repository?.Dispose();
        _repository = null;
    }
}
