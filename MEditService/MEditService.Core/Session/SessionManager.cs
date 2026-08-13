using MEditService.Core.Edits;
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
    IModImporter? modImporter = null) : ISessionManager, IDisposable
{
    private readonly Lock _lock = new();
    private readonly ILogger<SessionManager> _logger = logger ?? NullLogger<SessionManager>.Instance;
    private readonly IRecordRepositoryFactory _repositoryFactory = repositoryFactory;
    private readonly IPluginWriter _writer = writer;
    private readonly IPendingChangeLifecycle? _changeLifecycle = pendingChanges as IPendingChangeLifecycle;
    private readonly IModImporter _modImporter = modImporter ?? new DefaultModImporter();
    private GameSession? _session;
    private IRecordRepository? _repository;
    private readonly Dictionary<string, uint> _nextFormIds = new(StringComparer.OrdinalIgnoreCase);

    private const string NoSessionMessage = "No session loaded.";

    private string? _dataFolderPath;
    private string? _pluginsTxtPath;
    private GameRelease _gameRelease;

    public IGameSession? Session { get { lock (_lock) return _session; } }
    public IRecordReader? Repository { get { lock (_lock) return _repository; } }

    public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease)
    {
        _logger.LogDebug("Session load starting. DataFolder={DataFolder} PluginsTxt={PluginsTxt} Game={Game}",
            dataFolderPath, pluginsTxtPath, gameRelease);

        try
        {
            lock (_lock)
            {
                DisposeCurrentSession();

                _logger.LogDebug("Creating game session (reading plugins list and opening binary overlays)");
                var session = new GameSession(dataFolderPath, pluginsTxtPath, gameRelease, _logger);
                try { IndexAndStore(session, gameRelease, dataFolderPath, pluginsTxtPath); }
                catch { session.Dispose(); throw; }
                _logger.LogDebug("Session load complete");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Session load failed");
            throw;
        }
    }

    // #269 / ADR-0036: real (MO2-backed) session loads carry each plugin's origin through to
    // GameSession — and since #270 / ADR-0035, its participation too.
    public void LoadExplicit(string gameDirectory, IReadOnlyList<(string Name, string Path, string Origin, bool Participates)> plugins, GameRelease gameRelease) =>
        LoadExplicitCore(gameDirectory, plugins.Count, gameRelease,
            logger => GameSession.LoadExplicit(gameDirectory, plugins, gameRelease, logger));

    private void LoadExplicitCore(string gameDirectory, int pluginCount, GameRelease gameRelease, Func<ILogger?, GameSession> buildSession)
    {
        _logger.LogDebug("Explicit session load starting. GameDir={GameDir} Plugins={Count} Game={Game}",
            gameDirectory, pluginCount, gameRelease);

        try
        {
            lock (_lock)
            {
                DisposeCurrentSession();

                _logger.LogDebug("Creating explicit game session from scattered paths");
                var session = buildSession(_logger);
                // No plugins.txt for an explicit session; the game directory is the implicit-master root.
                try { IndexAndStore(session, gameRelease, gameDirectory, pluginsTxtPath: null); }
                catch { session.Dispose(); throw; }
                _logger.LogDebug("Explicit session load complete");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Explicit session load failed");
            throw;
        }
    }

    // Indexes the session's plugins into a fresh repository, computes winners, and swaps it in as the
    // single active session (ADR-0015). Must be called under _lock after DisposeCurrentSession.
    private void IndexAndStore(GameSession session, GameRelease gameRelease, string dataFolderPath, string? pluginsTxtPath)
    {
        _logger.LogDebug("Game session created. {Count} plugin(s) loaded: {Names}",
            session.Plugins.Count, string.Join(", ", session.Plugins.Select(p => p.Name)));

        _logger.LogDebug("Initializing DuckDB record repository");
        var repository = _repositoryFactory.Create(gameRelease);

        _nextFormIds.Clear();
        foreach (var plugin in session.Plugins)
        {
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

            if (!plugin.IsImmutable)
                _nextFormIds[plugin.Name] = SafeNextFormId(mod);
        }

        _logger.LogDebug("Computing winners");
        repository.UpdateWinners();

        _changeLifecycle?.OnSessionLoaded(repository.Connection);
        _session = session;
        _repository = repository;
        _dataFolderPath = dataFolderPath;
        _pluginsTxtPath = pluginsTxtPath;
        _gameRelease = gameRelease;
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
                .DefaultIfEmpty(_session.Plugins.Max(p => p.LoadOrderIndex) + 1)
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
        var result = await _writer.SaveAsync(metadata.Path, changes, gameRelease, BuildTypedLinkCache(gameRelease));
        await ReindexPlugin(plugin);
        return result;
    }

    public async Task<PreparedPluginSave> PreparePluginSave(string plugin, IReadOnlyList<PendingChange> changes)
    {
        var (metadata, _, gameRelease) = RequirePlugin(plugin);
        return await _writer.PrepareAsync(metadata.Path, changes, gameRelease, BuildTypedLinkCache(gameRelease));
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
        lock (_lock)
            DisposeCurrentSession();
    }

    public void Dispose()
    {
        lock (_lock)
            DisposeCurrentSession();
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
