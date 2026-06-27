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

public sealed class SessionManager : ISessionManager, IDisposable
{
    private readonly Lock _lock = new();
    private readonly ILogger<SessionManager> _logger;
    private readonly IRecordRepositoryFactory _repositoryFactory;
    private readonly IPluginWriter _writer;
    private readonly IPendingChangeLifecycle? _changeLifecycle;
    private readonly IModImporter _modImporter;
    private GameSession? _session;
    private IRecordRepository? _repository;
    private readonly Dictionary<string, uint> _nextFormIds = new(StringComparer.OrdinalIgnoreCase);

    private const string NoSessionMessage = "No session loaded.";

    private string? _dataFolderPath;
    private string? _pluginsTxtPath;
    private GameRelease _gameRelease;

    public SessionManager(
        IRecordRepositoryFactory repositoryFactory,
        IPluginWriter writer,
        IPendingChangeService? pendingChanges = null,
        ILogger<SessionManager>? logger = null,
        IModImporter? modImporter = null)
    {
        _repositoryFactory = repositoryFactory;
        _writer = writer;
        _changeLifecycle = pendingChanges as IPendingChangeLifecycle;
        _logger = logger ?? NullLogger<SessionManager>.Instance;
        _modImporter = modImporter ?? new DefaultModImporter();
    }

    public IGameSession? Session { get { lock (_lock) return _session; } }
    public IRecordReader? Repository { get { lock (_lock) return _repository; } }

    public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease)
    {
        _logger.LogInformation("Session load starting. DataFolder={DataFolder} PluginsTxt={PluginsTxt} Game={Game}",
            dataFolderPath, pluginsTxtPath, gameRelease);

        try
        {
            lock (_lock)
            {
                DisposeCurrentSession();

                _logger.LogInformation("Creating game session (reading plugins list and opening binary overlays)");
                var session = new GameSession(dataFolderPath, pluginsTxtPath, gameRelease, _logger);
                _logger.LogInformation("Game session created. {Count} plugin(s) loaded: {Names}",
                    session.Plugins.Count,
                    string.Join(", ", session.Plugins.Select(p => p.Name)));

                _logger.LogInformation("Initializing DuckDB record repository");
                var repository = _repositoryFactory.Create(gameRelease);

                _nextFormIds.Clear();
                foreach (var plugin in session.Plugins)
                {
                    var mod = session.GetMod(plugin.Name)!;

                    _logger.LogInformation("Indexing {Plugin} ({RecordCount} records)", plugin.Name, plugin.RecordCount);
                    repository.Index(mod, plugin.LoadOrderIndex);
                    _logger.LogInformation("Indexed {Plugin}", plugin.Name);

                    if (!plugin.IsImmutable)
                        _nextFormIds[plugin.Name] = mod.NextFormID;
                }

                _logger.LogInformation("Computing winners");
                repository.UpdateWinners();

                _changeLifecycle?.OnSessionLoaded(repository.Connection);
                _session = session;
                _repository = repository;
                _dataFolderPath = dataFolderPath;
                _pluginsTxtPath = pluginsTxtPath;
                _gameRelease = gameRelease;
                _logger.LogInformation("Session load complete");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Session load failed");
            throw;
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

            var filePath = Path.Combine(_dataFolderPath!, name);
            if (File.Exists(filePath))
                throw new IOException($"Plugin file already exists: {name}");

            var modKey = ModKey.FromFileName(name);
            var mod = ModFactory.Activator(modKey, _gameRelease);
            mod.WriteToBinary(filePath);

            File.AppendAllText(_pluginsTxtPath!, $"*{name}\n");

            var metadata = _session.AddPlugin(filePath);
            _nextFormIds[name] = ModFactory.Activator(modKey, _gameRelease).NextFormID;
            return PluginResponse.FromMetadata(metadata);
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
            var mods = _session!.Plugins
                .Select(p => _session.GetMod(p.Name))
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
            repository.Index(loaded.Getter, metadata.LoadOrderIndex);
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
                    repository.Index(item.Getter, metadata.LoadOrderIndex);
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
            var meta = _session.Plugins.FirstOrDefault(p =>
                string.Equals(p.Name, plugin, StringComparison.OrdinalIgnoreCase));
            if (meta == null)
                throw new KeyNotFoundException($"Plugin '{plugin}' not found in session.");
            return (meta, _repository!, _gameRelease);
        }
    }

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
