using System.Diagnostics;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceRepo;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index;

/// <summary>The copies the Index has open (ADR-0013), keyed by identity: what the adapter read out
/// of each file. Not a load order — who wins and who participates is the kernel's value. Reconcile
/// mutates it in place.</summary>
internal sealed class HeldPlugins
{
    private readonly List<PluginMetadata> _plugins = [];
    private readonly IPluginAdapter _adapter;
    private readonly ILogger _logger;

    // ADR-0012: keyed by the compound (origin, filename) identity — two copies of one filename are
    // ordinarily held at once. Compared as every other keyed lookup compares it, the kernel's own
    // comparer.
    private readonly Dictionary<PluginCopyKey, PluginLoadFailure> _loadFailures = new(PluginCopyKey.Comparer);

    // What is open is read while it is being reconciled, so readers see an immutable snapshot.
    // Copy-on-write, not copy-on-read: opens are a few hundred per cold reconcile, while reads walk
    // these lists on every request.
    private readonly Lock _mutation = new();
    private PluginMetadata[] _pluginsSnapshot = [];
    private IReadOnlyDictionary<PluginCopyKey, PluginContent> _openedSnapshot =
        new Dictionary<PluginCopyKey, PluginContent>(PluginCopyKey.Comparer);
    private PluginLoadFailure[] _loadFailuresSnapshot = [];

    public string DataFolderPath { get; }

    /// <summary>ADR-0009: the MO2 instance root the index file is keyed on, because <c>origin</c>
    /// is a mod folder name and so is unique only within one instance. Null asks for an in-memory
    /// index.</summary>
    public string? InstanceRoot { get; }

    public GameRelease GameRelease { get; }

    /// <summary>The metadata of every copy currently open, in the order they were opened.</summary>
    public IReadOnlyList<PluginMetadata> Plugins => Volatile.Read(ref _pluginsSnapshot);

    /// <summary>What reading each open copy told the Index, for the reads to hand out.</summary>
    public IReadOnlyDictionary<PluginCopyKey, PluginContent> OpenedCopies => Volatile.Read(ref _openedSnapshot);
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

    public PluginMetadata? Find(PluginCopyKey key) =>
        Plugins.FirstOrDefault(p => PluginCopyKey.Comparer.Equals(p.Key, key));

    /// <summary>A copy that cannot be opened or parsed must not abort the whole reconcile: it is
    /// recorded in <see cref="Failures"/> and nothing is held for it. A success clears any
    /// earlier failure for the same copy.</summary>
    public PluginMetadata? Open(RegisteredCopy plugin)
    {
        if (!File.Exists(plugin.Path))
        {
            _logger.LogWarning("Plugin file not found: {FilePath}", plugin.Path);
            SetFailure(plugin.Key, $"Plugin file not found: {plugin.Path}");
            return null;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Opening binary overlay: {FileName} ({Origin}, slot={Slot}, enabled={Enabled}, winning={Winning})",
                plugin.Name, plugin.Origin, plugin.Registration.LoadOrderIndex, plugin.Registration.Enabled, plugin.Registration.Winning);
        }

        try
        {
            // The binary path — the "binary is for untracked plugins" overlay (ADR-0007
            // amendment) — needs the same explicit strings parameters Track does, or a Localized
            // untracked plugin throws instead of opening.
            var readTimer = Stopwatch.StartNew();
            var (content, unreachable) = _adapter.ReadContent(
                new ModPath(ModKey.FromFileName(plugin.Name), plugin.Path), GameRelease,
                new PluginStrings(LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path), DataFolderPath));
            var readMs = readTimer.ElapsedMilliseconds;

            if (unreachable is { } stoppedWalk)
            {
                // The ingest walks the same records per type and reports the one it could not finish,
                // so this only keeps a readout from becoming a refusal to open the plugin.
                _logger.LogWarning(stoppedWalk,
                    "Could not walk all of {FileName}'s records for its count; reporting the {Count} that were reachable",
                    plugin.Name, content.RecordCount);
            }

            var metadata = BuildPluginMetadata(content, plugin);
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
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            _logger.LogWarning(ex, "Failed to open plugin {FileName} ({Origin}); it is held in an error state", plugin.Name, plugin.Origin);
            SetFailure(plugin.Key, PluginLoadFailure.ReasonFor(ex));
            return null;
        }
    }

    // Republishes the snapshot readers see, so a copy is never half-held from a reader's point of
    // view. Replaces any copy already held under the same key: two PluginMetadata under one
    // (origin, filename) would make every keyed lookup ambiguous.
    private void Hold(PluginMetadata metadata)
    {
        lock (_mutation)
        {
            _plugins.RemoveAll(p => PluginCopyKey.Comparer.Equals(p.Key, metadata.Key));
            _plugins.Add(metadata);
            PublishPlugins();
            _loadFailures.Remove(metadata.Key);
            Volatile.Write(ref _loadFailuresSnapshot, [.. _loadFailures.Values]);
        }
    }

    // Both views of what is held are republished together, under _mutation, so a reader can never
    // see a copy in one and not the other.
    private void PublishPlugins()
    {
        Volatile.Write(ref _pluginsSnapshot, [.. _plugins]);
        Volatile.Write(ref _openedSnapshot, _plugins.ToDictionary(p => p.Key, p => p.Content, PluginCopyKey.Comparer));
    }

    /// <summary>The load order's half of a copy leaving the snapshot. The index side is
    /// the Index's own unregister: the rows stay for the next snapshot that wants them.</summary>
    public bool Remove(PluginCopyKey key)
    {
        lock (_mutation)
        {
            var removed = _plugins.RemoveAll(p => PluginCopyKey.Comparer.Equals(p.Key, key)) > 0;
            if (_loadFailures.Remove(key))
            {
                Volatile.Write(ref _loadFailuresSnapshot, [.. _loadFailures.Values]);
                removed = true;
            }
            if (removed) PublishPlugins();
            return removed;
        }
    }

    /// <summary>Nothing here opens or re-reads the file: none of the three registration facts is a
    /// property of its content, and re-deriving anything else would let a reconcile silently
    /// re-read.</summary>
    public PluginMetadata Update(PluginMetadata previous, Registration registration)
    {
        var metadata = previous with
        {
            LoadOrderIndex = registration.LoadOrderIndex,
            Enabled = registration.Enabled,
            Winning = registration.Winning,
        };

        lock (_mutation)
        {
            var index = _plugins.FindIndex(p => PluginCopyKey.Comparer.Equals(p.Key, previous.Key));
            if (index < 0)
                throw new KeyNotFoundException($"No plugin '{previous.Name}' from origin '{previous.Origin}' is held.");

            _plugins[index] = metadata;
            PublishPlugins();
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Updated {FileName} ({Origin}): slot={Slot}, enabled={Enabled}, winning={Winning}",
                previous.Name, previous.Origin, registration.LoadOrderIndex, registration.Enabled, registration.Winning);
        }
        return metadata;
    }

    /// <summary>Lets the projector report a post-open failure (an indexing throw from malformed record
    /// data Mutagen can't parse) through the same channel as open failures.</summary>
    internal void SetFailure(PluginCopyKey key, string reason)
    {
        lock (_mutation)
        {
            _loadFailures[key] = new PluginLoadFailure(key.Name, key.Origin, reason);
            Volatile.Write(ref _loadFailuresSnapshot, [.. _loadFailures.Values]);
        }
    }

    private static PluginMetadata BuildPluginMetadata(PluginContent content, RegisteredCopy plugin) =>
        new(
            Name: plugin.Name,
            Path: plugin.Path,
            LoadOrderIndex: plugin.Registration.LoadOrderIndex,
            IsLight: content.IsLight,
            IsMaster: content.IsMaster,
            Masters: content.Masters,
            RecordCount: content.RecordCount,
            IsForced: plugin.IsForced,
            Origin: plugin.Origin,
            Enabled: plugin.Registration.Enabled,
            Winning: plugin.Registration.Winning);
}
