using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Session;

public sealed class SessionManager : ISessionManager, IDisposable
{
    private readonly Lock _lock = new();
    private readonly ILogger<SessionManager> _logger;
    private readonly IRecordRepositoryFactory _repositoryFactory;
    private readonly IPluginWriter _writer;
    private readonly IPendingChangeLifecycle? _changeLifecycle;
    private GameSession? _session;
    private IRecordRepository? _repository;
    private readonly Dictionary<string, uint> _nextFormIds = new(StringComparer.OrdinalIgnoreCase);

    private string? _dataFolderPath;
    private string? _pluginsTxtPath;
    private GameRelease _gameRelease;

    public SessionManager(
        IRecordRepositoryFactory repositoryFactory,
        IPluginWriter writer,
        IPendingChangeService? pendingChanges = null,
        ILogger<SessionManager>? logger = null)
    {
        _repositoryFactory = repositoryFactory;
        _writer = writer;
        _changeLifecycle = pendingChanges as IPendingChangeLifecycle;
        _logger = logger ?? NullLogger<SessionManager>.Instance;
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
                throw new InvalidOperationException("No session loaded.");

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
        PluginMetadata metadata;
        IRecordRepository repository;
        GameRelease gameRelease;

        lock (_lock)
        {
            if (_session == null)
                throw new InvalidOperationException("No session loaded.");
            var meta = _session.Plugins.FirstOrDefault(p =>
                string.Equals(p.Name, plugin, StringComparison.OrdinalIgnoreCase));
            if (meta == null)
                throw new KeyNotFoundException($"Plugin '{plugin}' not found in session.");
            metadata = meta;
            repository = _repository!;
            gameRelease = _gameRelease;
        }

        var result = await _writer.SaveAsync(metadata.Path, changes, gameRelease);

        var modKey = ModKey.FromFileName(Path.GetFileName(metadata.Path));
        var modPath = new ModPath(modKey, metadata.Path);
        using var mod = ModFactory.ImportGetter(modPath, gameRelease);

        lock (_lock)
        {
            repository.Index(mod, metadata.LoadOrderIndex);
            repository.UpdateWinners();
        }

        return result;
    }

    public string ReserveFormKey(string plugin)
    {
        lock (_lock)
        {
            if (_session == null)
                throw new InvalidOperationException("No session loaded.");
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
                throw new InvalidOperationException("No session loaded.");
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
