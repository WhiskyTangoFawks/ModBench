using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Session;

public sealed class SessionManager(
    IRecordRepositoryFactory repositoryFactory,
    IPluginWriter writer,
    IPendingChangeService? pendingChanges = null,
    ILogger<SessionManager>? logger = null,
    IModImporter? modImporter = null,
    // #392: optional the same way pendingChanges/modImporter are — every production DI registration
    // supplies one (Program.cs), but a test constructing SessionManager directly for a scenario that
    // has nothing to do with the ledger shouldn't have to.
    LedgerLifecycleReconciler? ledgerReconciler = null) : ISessionManager, IDisposable
{
    private readonly Lock _lock = new();
    private readonly ILogger<SessionManager> _logger = logger ?? NullLogger<SessionManager>.Instance;
    private readonly IRecordRepositoryFactory _repositoryFactory = repositoryFactory;
    private readonly IPluginWriter _writer = writer;
    private readonly IPendingChangeLifecycle? _changeLifecycle = pendingChanges as IPendingChangeLifecycle;
    // #279: a re-read discards the staged edits belonging to the copy it replaces, so this needs
    // the service itself, not only its lifecycle half.
    private readonly IPendingChangeService? _pendingChanges = pendingChanges;
    private readonly IModImporter _modImporter = modImporter ?? new DefaultModImporter();
    private readonly LedgerLifecycleReconciler? _ledgerReconciler = ledgerReconciler;
    private GameSession? _session;
    private IRecordRepository? _repository;
    private readonly Dictionary<string, uint> _nextFormIds = new(StringComparer.OrdinalIgnoreCase);
    // #274: the load's own progress. Guarded by _lock like _session/_repository — written by the
    // loading thread as each plugin lands, read by whoever asks for Status meanwhile.
    private readonly List<IndexedPlugin> _indexed = [];
    private bool _conflictsComputed;

    // #274: at most one load or teardown at a time, and an in-flight load stops promptly when
    // another arrives. Two mechanisms, because one is not enough: the token *asks* the loop to stop,
    // and the gate waits until it actually has. Cancelling without draining is the dangerous half —
    // it would let a teardown dispose the DuckDB connection while the loop is still writing to it,
    // which is a native crash rather than an exception, taking the backend and any staged edits with
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

    private string? _dataFolderPath;
    private string? _pluginsTxtPath;
    private GameRelease _gameRelease;

    public IGameSession? Session { get { lock (_lock) return _session; } }
    public IRecordReader? Repository { get { lock (_lock) return _repository; } }

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
        _logger.LogDebug("Session load starting. DataFolder={DataFolder} PluginsTxt={PluginsTxt} Game={Game}",
            dataFolderPath, pluginsTxtPath, gameRelease);

        RunLoad(
            dataFolderPath, pluginsTxtPath, gameRelease,
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
        _logger.LogDebug("Explicit session load starting. GameDir={GameDir} Plugins={Count} Game={Game}",
            gameDirectory, pluginCount, gameRelease);

        // No plugins.txt for an explicit session; the game directory is the implicit-master root.
        RunLoad(
            gameDirectory, pluginsTxtPath: null, gameRelease, buildSession,
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
        string dataFolderPath, string? pluginsTxtPath, GameRelease gameRelease,
        Func<ILogger?, GameSession> buildSession, string buildingMessage, string completeMessage, string failedMessage)
    {
        EnterExclusive();
        try
        {
            var token = BeginLoad();

            _logger.LogDebug("{Step}", buildingMessage);
            var session = buildSession(_logger);
            // IndexAndStore tears down a session it has already published; this covers the window
            // before that, where the failure belongs to nobody else.
            try { IndexAndStore(session, gameRelease, dataFolderPath, pluginsTxtPath, token); }
            catch { session.Dispose(); throw; }
            _logger.LogDebug("{Step}", completeMessage);
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
    private void IndexAndStore(
        GameSession session, GameRelease gameRelease, string dataFolderPath, string? pluginsTxtPath, CancellationToken token)
    {
        _logger.LogDebug("Initializing DuckDB record repository");
        var repository = _repositoryFactory.Create(gameRelease);

        lock (_lock)
        {
            _nextFormIds.Clear();
            _indexed.Clear();
            _conflictsComputed = false;
            // Before the loop: pending changes rebind to this connection and ensure their table, and
            // a read arriving mid-load must not find that table missing.
            _changeLifecycle?.OnSessionLoaded(repository.Connection);
            _session = session;
            _repository = repository;
            _dataFolderPath = dataFolderPath;
            _pluginsTxtPath = pluginsTxtPath;
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

    private void IndexProgressively(GameSession session, IRecordRepository repository, CancellationToken token)
    {
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

            _logger.LogInformation("Indexing {Plugin} ({RecordCount} records)", plugin.Name, plugin.RecordCount);
            try
            {
                // #271 / ADR-0036: threads the origin GameSession already resolved (#269) into the
                // index, so the DuckDB row is identified by (origin, plugin) together, not filename
                // alone.
                repository.Index(mod, plugin.LoadOrderIndex, plugin.Participates, plugin.Origin);
            }
            catch (Exception ex)
            {
                // A single plugin with malformed record data (e.g. Mutagen can't parse it) must not
                // abort the whole load order — same isolation GameSession already gives ImportGetter
                // failures, extended to this later indexing stage (Index() runs in its own DuckDB
                // transaction, so the rollback on throw leaves no partial rows behind).
                _logger.LogWarning(ex, "Failed to index {Plugin}; its records will not be queryable this session", plugin.Name);
                session.RecordIndexFailure(plugin.Name, ex.Message);
                continue;
            }

            lock (_lock)
            {
                // Recorded only once Index() has returned: Status promises a plugin here is wholly
                // queryable, so listing it any earlier would be the partial-visibility lie in a
                // different form.
                _indexed.Add(new IndexedPlugin(plugin.Name, plugin.Origin));
                // ReserveFormKey reads this dictionary, and it is now reachable mid-load like
                // every other published read.
                if (!plugin.IsImmutable) _nextFormIds[plugin.Name] = SafeNextFormId(mod);
            }
        }

        // #274: reported after the loop, not before it — the count is not knowable until the load
        // order has been walked, because opening is now what discovers it.
        _logger.LogDebug("Game session indexed. {Count} plugin(s) loaded: {Names}",
            session.Plugins.Count, string.Join(", ", session.Plugins.Select(p => p.Name)));

        // The whole-set sweep, and the moment conflict information becomes correct: a plugin that
        // arrived earlier was browsable but its winner state was not yet decided (ADR-0035).
        _logger.LogDebug("Computing winners");
        repository.UpdateWinners();
        lock (_lock) _conflictsComputed = true;

        ReconcileLedgerLifecycle(session, repository);
    }

    // #392: session load is the only point Editing re-observes each origin folder's current
    // physical contents — nothing in Modbench deletes or renames a plugin file itself, so there is
    // no hook to fire on a delete that never happens. Best-effort, same convention as
    // EditOrchestrator.VendorOnFirstTouch and LedgerGroupCommitter: a failure here must never turn
    // an already-successful load into a reported one, and the reconciler's own per-origin-folder
    // loop already isolates one folder's failure from the rest — this catch is only the outermost
    // safety net. GetAwaiter().GetResult() bridges the reconciler's async API into this fully
    // synchronous load path, the same bridge EditOrchestrator.VendorOnFirstTouch already uses for
    // RecordVendor's own async ledger call.
    private void ReconcileLedgerLifecycle(GameSession session, IRecordRepository repository)
    {
        if (_ledgerReconciler == null) return;

        try
        {
            _ledgerReconciler.ReconcileAsync(
                session.Plugins,
                (recordType, formKeyString, plugin, origin) =>
                    repository.GetRecord(recordType, formKeyString, plugin, origin, winnerOnly: false) != null)
                .GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Ledger lifecycle reconciliation failed for this session load; left for the next one");
        }
    }

    public PluginResponse CreatePlugin(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("Plugin name cannot be empty.", nameof(name));

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

            if (_pluginsTxtPath is null)
                throw new InvalidOperationException("Cannot create a plugin in an explicit session — no plugins.txt to update.");

            var filePath = Path.Combine(_dataFolderPath!, name);
            if (File.Exists(filePath))
                throw new IOException($"Plugin file already exists: {name}");

            var modKey = ModKey.FromFileName(name);
            var mod = ModFactory.Activator(modKey, _gameRelease);
            mod.WriteToBinary(filePath);

            File.AppendAllText(_pluginsTxtPath!, $"*{name}\n");

            var metadata = _session.AddPlugin(filePath);
            _nextFormIds[name] = SafeNextFormId(ModFactory.Activator(modKey, _gameRelease));
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

            _logger.LogInformation("Loading unlisted plugin {Name} from {Origin} at load-order slot {Index}", name, origin, loadOrderIndex);
            var metadata = _session.AddUnlistedPlugin(path, origin, loadOrderIndex);
            var mod = _session.GetMod(metadata.Name, metadata.Origin)!;

            // No UpdateWinners: a non-participating plugin is excluded from the winner sweep by the
            // `plugins` join, so nothing already computed can change. That is the whole reason
            // ADR-0035 lets these arrive lazily while load-order plugins must load together.
            _repository!.Index(mod, metadata.LoadOrderIndex, metadata.Participates, metadata.Origin);
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

            _logger.LogInformation("Unloading unlisted plugin {Plugin} from {Origin}", plugin, origin);
            _repository!.Unindex(plugin, origin);
        }
    }

    public async Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes)
    {
        var (metadata, _, gameRelease) = RequirePlugin(plugin);
        var result = await _writer.SaveAsync(
            metadata.Path, changes, gameRelease, BuildTypedLinkCache(gameRelease), MastersWritingOrder());
        await ReindexPlugin(plugin);
        return result;
    }

    public async Task<PreparedPluginSave> PreparePluginSave(string plugin, IReadOnlyList<PendingChange> changes)
    {
        var (metadata, _, gameRelease) = RequirePlugin(plugin);
        return await _writer.PrepareAsync(
            metadata.Path, changes, gameRelease, BuildTypedLinkCache(gameRelease), MastersWritingOrder());
    }

    // Typed link cache over the session's load-order getters; the placed-record write paths in
    // PluginWriter need the typed cache for GetOrAddAsOverride (see TypedLinkCacheFactory).
    private ILinkCache BuildTypedLinkCache(GameRelease gameRelease)
    {
        lock (_lock)
        {
            // #34: load-order members only. A plugin loaded outside the load order is not in the
            // game's load order by definition, and Mutagen's LoadOrder refuses a second listing
            // for a filename it already holds — the write paths this cache serves only ever
            // target load-order plugins anyway.
            var mods = _session!.Plugins
                .Where(p => p.InLoadOrder)
                .Select(p => _session.GetMod(p.Name, p.Origin))
                .OfType<IModGetter>()
                .ToList();
            return TypedLinkCacheFactory.Create(mods, gameRelease);
        }
    }

    // #337/ADR-0038: what PluginWriter orders the written masters list by, and — just as load-
    // bearing — the completeness guarantee that keeps WithMastersListOrdering from throwing
    // MissingModException when Iterate's content-sync needs a master this list doesn't name (not
    // defensive padding: proved reachable, not hypothetical — see below). Session-wide rather than
    // scoped to the plugin being saved: nothing on PendingChange records which plugin a copy's
    // fields originated from, and per-change-origin scoping would need new plumbing to track it.
    // Every session plugin's name, unioned with every session plugin's own already-committed
    // Masters (one hop, not recursive — justified below) is simpler and provably total instead.
    //
    // Result is the same for every plugin in a given session — deliberately not parameterized by
    // which one is being saved.
    //
    // Proof of totality: every FormKey Iterate could ever need as a new master for the plugin being
    // saved comes from a FormLink embedded somewhere in that plugin's post-edit content. That
    // FormLink arrived one of two ways. (1) It was already on the plugin's own on-disk content
    // before this save — closed over that plugin's own on-disk masters (its own PluginMetadata.
    // Masters) at binary-parse time, since Mutagen resolves a local master index into a ModKey
    // using only the parsed file's own master-list metadata, never anything external — the same
    // #277 "declared-but-absent master" shape as before, just now stated for any session plugin,
    // not only the save target. (2) It arrived via a pending change's NewValue. Every pending
    // change's NewValue is either schema-validated (EditOrchestrator.ValidateReferences, on
    // StageEdit's and CreateRecordCore's template-copy path), which requires the FormKey resolve
    // via RecordQueryService — i.e. belong to an *indexed*, hence session-loaded, plugin — or
    // copied verbatim from an existing record's already-resolved fields (CopyRecordTo, which skips
    // ValidateReferences — confirmed reachable via review: a copy can carry a FormLink the source
    // plugin alone declares as a master). CopyRecordTo's only source, RecordQueryService.GetRecord/
    // GetRecordForPlugin, reads committed (indexed) data only, never a pending overlay, so that
    // source record is itself on-disk content of some session-loaded plugin — closed over *that*
    // plugin's own on-disk masters by the same parse-time argument as (1). Either way, every
    // possible new master is a name in _session.Plugins or a name in some session plugin's own
    // already-committed Masters — exactly this union. One hop suffices because PluginMetadata.
    // Masters is already each plugin's own fully-resolved master list; nothing here ever needs to
    // chase a master's own masters transitively.
    private List<string> MastersWritingOrder()
    {
        lock (_lock)
        {
            var ordered = _session!.Plugins.OrderBy(p => p.LoadOrderIndex).ToList();
            return ordered
                .Select(p => p.Name)
                .Concat(ordered.SelectMany(p => p.Masters))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
    }

    /// <summary>
    /// #279 / ADR-0035 § Live mutation: re-reads one plugin from the copy a mod-level change has
    /// made its name resolve to, and re-indexes only that plugin. Never automatic — the drifted row
    /// offers this, the user asks for it, and the confirm has already stated what it costs.
    /// </summary>
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

            _logger.LogInformation("Re-reading {Plugin}: {OldOrigin} → {NewOrigin}", plugin, previous.Origin, newOrigin);

            // Rebind first — it opens the new file, which is the failure-prone half, and it leaves
            // the session untouched if that open throws.
            var metadata = _session!.RebindPlugin(previous, newPath, newOrigin);

            // Then the staged edits belonging to the copy that just went away. Discarded, not
            // migrated and not left alone: pending_changes is keyed on (form_key, origin, plugin)
            // and reads overlay by origin, so a change left behind is invisible yet still live —
            // and SavePlugin resolves its write target by *filename*, so it would later be written
            // into the new copy's file having been authored against bytes that no longer exist
            // (ADR-0026's silent-wrong-state tier). Migrating them is worse still: their OldValue
            // describes those same vanished bytes. Deliberately before the re-index rather than
            // after it: if indexing then throws, staged edits are gone but nothing is left
            // invisible-but-live, which is the safer of the two bad outcomes.
            var discarded = _pendingChanges?.Revert(metadata.Name, formKey: null, origin: previous.Origin) ?? 0;
            if (discarded > 0)
                _logger.LogInformation("Discarded {Count} staged change(s) against {Plugin} from {Origin}", discarded, plugin, previous.Origin);

            repository.Unindex(previous.Name, previous.Origin);
            var mod = _session.GetMod(metadata.Name, metadata.Origin)!;
            repository.Index(mod, metadata.LoadOrderIndex, metadata.Participates, metadata.Origin);
            // AC7: the whole-set sweep, so winner status and conflict badges describe the new file.
            repository.UpdateWinners();

            // The reservation counter belongs to the file, not the name — the new copy has its own
            // NextFormID, and keeping the old one would hand out FormKeys it has already used.
            if (!metadata.IsImmutable) _nextFormIds[metadata.Name] = SafeNextFormId(mod);

            return PluginResponse.FromMetadata(metadata);
        }
    }

    public Task ReindexPlugin(string plugin)
    {
        var (metadata, repository, gameRelease) = RequirePlugin(plugin);

        var modKey = ModKey.FromFileName(Path.GetFileName(metadata.Path));
        var modPath = new ModPath(modKey, metadata.Path);
        using var loaded = _modImporter.Import(modPath, gameRelease);

        lock (_lock)
        {
            repository.Index(loaded.Getter, metadata.LoadOrderIndex, metadata.Participates, metadata.Origin);
            repository.UpdateWinners();
        }

        return Task.CompletedTask;
    }

    public Task ReindexPlugins(IReadOnlyList<string> plugins)
    {
        var loaded = new List<(PluginMetadata Metadata, IRecordRepository Repository, ILoadedMod Loaded)>(plugins.Count);
        try
        {
            foreach (var plugin in plugins)
            {
                var (metadata, repository, gameRelease) = RequirePlugin(plugin);
                var modKey = ModKey.FromFileName(Path.GetFileName(metadata.Path));
                var modPath = new ModPath(modKey, metadata.Path);
                loaded.Add((metadata, repository, _modImporter.Import(modPath, gameRelease)));
            }

            lock (_lock)
            {
                foreach (var (metadata, repository, item) in loaded)
                    repository.Index(item.Getter, metadata.LoadOrderIndex, metadata.Participates, metadata.Origin);
                if (loaded.Count > 0)
                    loaded[0].Repository.UpdateWinners();
            }
        }
        finally
        {
            foreach (var (_, _, item) in loaded)
                item.Dispose();
        }

        return Task.CompletedTask;
    }

    private (PluginMetadata Metadata, IRecordRepository Repository, GameRelease GameRelease) RequirePlugin(string plugin)
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

    // FormID 0 is reserved: Issue #1's plugin-header record lives at the synthetic FormKey
    // `000000:<plugin>` (see HeaderIndexer). A plugin that has never had a record added (freshly
    // created, or written by PluginFixtureBuilder with no explicit NextFormID) reports a raw
    // NextFormID of 0, which would otherwise collide with its own header row on first reservation —
    // floor it at the game's recommended starting FormID instead.
    private static uint SafeNextFormId(IModGetter mod) => Math.Max(mod.NextFormID, mod.GetDefaultInitialNextFormID());

    public string ReserveFormKey(string plugin)
    {
        lock (_lock)
        {
            if (_session == null)
                throw new InvalidOperationException(NoSessionMessage);
            if (!_nextFormIds.TryGetValue(plugin, out var nextId))
                throw new ArgumentException($"Plugin '{plugin}' has no reservation counter (not loaded or immutable).", nameof(plugin));
            if (nextId > 0xFFFFFF)
                throw new InvalidOperationException($"Plugin '{plugin}' has exhausted its FormKey space (NextFormID 0x{nextId:X} exceeds 0xFFFFFF).");
            var formKey = Mutagen.Bethesda.Plugins.FormKey.Factory($"{nextId:X6}:{plugin}");
            _nextFormIds[plugin] = nextId + 1;
            return formKey.ToString();
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
        _changeLifecycle?.OnSessionUnloaded();
        _session?.Dispose();
        _session = null;
        _repository?.Dispose();
        _repository = null;
    }
}
