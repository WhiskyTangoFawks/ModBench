using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
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
    private readonly ISchemaReflector _schemaReflector;
    private readonly ITableDdlBuilder _ddlBuilder;
    private readonly IFieldMetadataMapper _metadataMapper;
    private IGameSession? _session;
    private IRecordRepository? _repository;
    private bool _disposed;

    private string? _dataFolderPath;
    private string? _pluginsTxtPath;
    private GameRelease _gameRelease;

    public SessionManager(
        ISchemaReflector schemaReflector,
        ITableDdlBuilder ddlBuilder,
        IFieldMetadataMapper metadataMapper,
        ILogger<SessionManager>? logger = null)
    {
        _schemaReflector = schemaReflector;
        _ddlBuilder = ddlBuilder;
        _metadataMapper = metadataMapper;
        _logger = logger ?? NullLogger<SessionManager>.Instance;
    }

    public IGameSession? Session { get { lock (_lock) return _session; } }
    public IRecordRepository? Repository { get { lock (_lock) return _repository; } }

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
                var repository = new DuckDbRecordRepository(_schemaReflector, _ddlBuilder, _metadataMapper, _logger);
                repository.Initialize(gameRelease);

                foreach (var plugin in session.Plugins)
                {
                    var mod = session.GetMod(plugin.Name)
                        ?? throw new InvalidOperationException($"Plugin {plugin.Name} not found in session");

                    _logger.LogInformation("Indexing {Plugin} ({RecordCount} records)", plugin.Name, plugin.RecordCount);
                    repository.Index(mod, plugin.LoadOrderIndex);
                    _logger.LogInformation("Indexed {Plugin}", plugin.Name);
                }

                _logger.LogInformation("Computing winners");
                repository.UpdateWinners();

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
            if (_dataFolderPath is null || _pluginsTxtPath is null)
                throw new InvalidOperationException("No session loaded.");

            var filePath = Path.Combine(_dataFolderPath, name);
            if (File.Exists(filePath))
                throw new IOException($"Plugin file already exists: {name}");

            var modKey = ModKey.FromFileName(name);
            var mod = ModFactory.Activator(modKey, _gameRelease);
            mod.WriteToBinary(filePath);

            File.AppendAllText(_pluginsTxtPath, $"*{name}\n");

            Load(_dataFolderPath, _pluginsTxtPath, _gameRelease);

            var created = _session!.Plugins.FirstOrDefault(p =>
                string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"Plugin '{name}' not found after reload.");

            return PluginResponse.FromMetadata(created);
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
        {
            if (_disposed) return;
            _disposed = true;
            DisposeCurrentSession();
        }
    }

    private void DisposeCurrentSession()
    {
        _session?.Dispose();
        _session = null;
        _repository?.Dispose();
        _repository = null;
    }
}
