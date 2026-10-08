using System.Diagnostics;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index;

/// <summary>The plugins the Index has open, keyed by identity: what the adapter read out of each
/// file. Not a load order (ADR-0013). Reconcile mutates it in place.</summary>
internal sealed class HeldPlugins
{
    private readonly List<PluginMetadata> _plugins = [];
    private readonly IPluginAdapter _adapter;
    private readonly ILogger _logger;

    // ADR-0012.
    private readonly Dictionary<PluginAddress, PluginLoadFailure> _loadFailures = new(PluginAddress.Comparer);

    // What is open is read while it is being reconciled, so readers see an immutable snapshot.
    // Copy-on-write, not copy-on-read: opens are a few hundred per cold reconcile, while reads walk
    // these lists on every request.
    private readonly Lock _mutation = new();
    private PluginMetadata[] _pluginsSnapshot = [];
    private IReadOnlyDictionary<PluginAddress, PluginContent> _openedSnapshot =
        new Dictionary<PluginAddress, PluginContent>(PluginAddress.Comparer);
    private PluginLoadFailure[] _loadFailuresSnapshot = [];

    public string DataFolderPath { get; }

    /// <summary>One index file per instance, inside the instance root (ADR-0010). Null asks for an in-memory index.</summary>
    public string? InstanceRoot { get; }

    public GameRelease GameRelease { get; }

    /// <summary>The metadata of every plugin currently open, in the order they were opened.</summary>
    public IReadOnlyList<PluginMetadata> Plugins => Volatile.Read(ref _pluginsSnapshot);

    /// <summary>What reading each open plugin told the Index, for the reads to hand out.</summary>
    public IReadOnlyDictionary<PluginAddress, PluginContent> OpenedPlugins => Volatile.Read(ref _openedSnapshot);
    public IReadOnlyList<PluginLoadFailure> Failures => Volatile.Read(ref _loadFailuresSnapshot);

    public HeldPlugins(
        IPluginAdapter adapter, string dataFolderPath, string? instanceRoot, GameRelease gameRelease,
        ILogger? logger = null)
    {
        _adapter = adapter;
        _logger = logger ?? NullLogger.Instance;
        DataFolderPath = dataFolderPath;
        InstanceRoot = instanceRoot;
        GameRelease = gameRelease;
    }

    public PluginMetadata? Find(PluginAddress key) =>
        Plugins.FirstOrDefault(p => PluginAddress.Comparer.Equals(p.Key, key));

    /// <summary>A plugin that cannot be parsed is recorded in <see cref="Failures"/> and nothing is
    /// held for it; a file that cannot be read throws, for its reader to read again. A success
    /// clears an earlier failure.</summary>
    public PluginMetadata? Open(RegisteredPlugin plugin, Registration registration)
    {
        if (!File.Exists(plugin.Path))
        {
            _logger.LogWarning("Plugin file not found: {FilePath}", plugin.Path);
            SetFailure(plugin.Key, $"Plugin file not found: {plugin.Path}");
            return null;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Opening binary overlay: {FileName} ({Origin}, load index {LoadOrderIndex})",
                plugin.Name, plugin.Origin, registration.LoadOrderIndex);
        }

        try
        {
            // The binary path (ADR-0007) needs the same explicit strings parameters
            // Track does, or a Localized untracked plugin throws instead of opening.
            var readTimer = Stopwatch.StartNew();
            var (content, unreachable) = _adapter.ReadContent(
                new ModPath(ModKey.FromFileName(plugin.Name), plugin.Path), GameRelease,
                new PluginStrings(Path.GetDirectoryName(plugin.Path), DataFolderPath));
            var readMs = readTimer.ElapsedMilliseconds;

            if (unreachable is { } stoppedWalk)
            {
                // The ingest walks the same records per type and reports the one it could not finish,
                // so this only keeps a readout from becoming a refusal to open the plugin.
                _logger.LogWarning(stoppedWalk,
                    "Could not walk all of {FileName}'s records for its count; reporting the {Count} that were reachable",
                    plugin.Name, content.RecordCount);
            }

            var metadata = BuildPluginMetadata(content, plugin, registration);
            Hold(metadata);

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("{FileName}: {RecordCount} records, masters: [{Masters}]",
                    plugin.Name, metadata.RecordCount, string.Join(", ", metadata.Masters));
            }
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("{FileName} read in {ReadMs} ms", plugin.Name, readMs);
            }
            return metadata;
        }
        catch (Exception ex) when (ex is not (OutOfMemoryException or IOException or UnauthorizedAccessException))
        {
            _logger.LogWarning(ex, "Failed to open plugin {FileName} ({Origin}); it is held in an error state", plugin.Name, plugin.Origin);
            SetFailure(plugin.Key, PluginLoadFailure.ReasonFor(ex));
            return null;
        }
    }

    // Republishes the snapshot readers see, so a plugin is never half-held from a reader's point of
    // view. Replaces any plugin already held under the same key: two PluginMetadata under one
    // (origin, filename) would make every keyed lookup ambiguous.
    private void Hold(PluginMetadata metadata)
    {
        lock (_mutation)
        {
            _plugins.RemoveAll(p => PluginAddress.Comparer.Equals(p.Key, metadata.Key));
            _plugins.Add(metadata);
            PublishPlugins();
            _loadFailures.Remove(metadata.Key);
            Volatile.Write(ref _loadFailuresSnapshot, [.. _loadFailures.Values]);
        }
    }

    // Both views of what is held are republished together, under _mutation, so a reader can never
    // see a plugin in one and not the other.
    private void PublishPlugins()
    {
        Volatile.Write(ref _pluginsSnapshot, [.. _plugins]);
        Volatile.Write(ref _openedSnapshot, _plugins.ToDictionary(p => p.Key, p => p.Content, PluginAddress.Comparer));
    }

    /// <summary>The load order's half of a plugin leaving the snapshot. The index side is
    /// the Index's own unregister: the rows stay for the next snapshot that wants them.</summary>
    public bool Remove(PluginAddress key)
    {
        lock (_mutation)
        {
            var removed = _plugins.RemoveAll(p => PluginAddress.Comparer.Equals(p.Key, key)) > 0;
            if (_loadFailures.Remove(key))
            {
                Volatile.Write(ref _loadFailuresSnapshot, [.. _loadFailures.Values]);
                removed = true;
            }
            if (removed) PublishPlugins();
            return removed;
        }
    }

    /// <summary>Nothing here opens or re-reads the file: the load index is no property of its
    /// content, and re-deriving anything else would let a reconcile silently re-read.</summary>
    public PluginMetadata Update(PluginMetadata previous, Registration registration)
    {
        var metadata = previous with { LoadOrderIndex = registration.LoadOrderIndex };

        lock (_mutation)
        {
            var index = _plugins.FindIndex(p => PluginAddress.Comparer.Equals(p.Key, previous.Key));
            if (index < 0)
                throw new KeyNotFoundException($"No plugin '{previous.Name}' from origin '{previous.Origin}' is held.");

            _plugins[index] = metadata;
            PublishPlugins();
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Updated {FileName} ({Origin}): load index {LoadOrderIndex}",
                previous.Name, previous.Origin, registration.LoadOrderIndex);
        }
        return metadata;
    }

    /// <summary>Lets the Indexer report a post-open failure (an indexing throw from malformed record
    /// data Mutagen can't parse) through the same channel as open failures. False when the plugin
    /// already failed for this reason.</summary>
    internal bool SetFailure(PluginAddress key, string reason)
    {
        var failure = new PluginLoadFailure(key.Name, key.Origin, reason);
        lock (_mutation)
        {
            if (_loadFailures.TryGetValue(key, out var standing) && standing == failure) return false;
            _loadFailures[key] = failure;
            Volatile.Write(ref _loadFailuresSnapshot, [.. _loadFailures.Values]);
            return true;
        }
    }

    /// <summary>Drops the failure an earlier read recorded, for a plugin that has just read cleanly.
    /// False when none was recorded.</summary>
    internal bool ClearFailure(PluginAddress key)
    {
        lock (_mutation)
        {
            if (!_loadFailures.Remove(key)) return false;
            Volatile.Write(ref _loadFailuresSnapshot, [.. _loadFailures.Values]);
            return true;
        }
    }

    /// <summary>Held, and its last read failed: a plugin the open itself failed on is not held, and
    /// has nothing to read again.</summary>
    internal bool IsHeldWithAFailure(PluginAddress key)
    {
        lock (_mutation)
        {
            return _loadFailures.ContainsKey(key)
                   && _plugins.Exists(p => PluginAddress.Comparer.Equals(p.Key, key));
        }
    }

    private static PluginMetadata BuildPluginMetadata(PluginContent content, RegisteredPlugin plugin, Registration registration) =>
        new(
            Name: plugin.Name,
            Path: plugin.Path,
            LoadOrderIndex: registration.LoadOrderIndex,
            IsLight: content.IsLight,
            IsMedium: content.IsMedium,
            IsMaster: content.IsMaster,
            IsBlueprint: content.IsBlueprint,
            Masters: content.Masters,
            RecordCount: content.RecordCount,
            Origin: plugin.Origin,
            Provider: plugin.Provider);
}
