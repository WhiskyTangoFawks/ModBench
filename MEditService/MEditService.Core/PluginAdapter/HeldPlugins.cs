using System.Diagnostics;
using MEditService.Core.Plugins;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.PluginAdapter;

/// <summary>The copies the Index has open (ADR-0013), keyed by identity: what it read out of each
/// file. Not a load order — who wins and who participates is the kernel's value. Reconcile mutates
/// it in place.</summary>
internal sealed class HeldPlugins : IDisposable
{
    // ADR-0012: keyed by the compound (origin, filename) identity — two copies of one filename are
    // ordinarily held at once, and a filename-keyed dictionary would silently drop one. Joined into
    // one string so a single OrdinalIgnoreCase comparer covers both halves.
    private readonly Dictionary<string, ILoadedMod> _modsByKey = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<PluginMetadata> _plugins = [];
    private readonly Dictionary<string, PluginLoadFailure> _loadFailures = new(StringComparer.OrdinalIgnoreCase);
    private readonly IPluginAdapter _adapter;
    private readonly ILogger _logger;

    private static string KeyOf(string origin, string name) => $"{origin}\0{name}";
    private static string KeyOf(PluginKey key) => KeyOf(key.Origin!, key.Name);

    // What is open is read while it is being reconciled, so readers see an immutable snapshot.
    // Copy-on-write, not copy-on-read: opens are a few hundred per cold reconcile, while reads walk
    // these lists on every request.
    private readonly Lock _mutation = new();
    private PluginMetadata[] _pluginsSnapshot = [];
    private IReadOnlyDictionary<PluginKey, PluginContent> _openedSnapshot =
        new Dictionary<PluginKey, PluginContent>(PluginKey.Comparer);
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
    public IReadOnlyDictionary<PluginKey, PluginContent> OpenedCopies => Volatile.Read(ref _openedSnapshot);
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

    public IModGetter? GetMod(string pluginName, string origin)
    {
        // Under the same lock as the writes: a Dictionary read concurrent with a write is not merely
        // stale, it can spin or throw. Cheap — this is per-save and per-index, not per-read.
        lock (_mutation)
            return _modsByKey.TryGetValue(KeyOf(origin, pluginName), out var mod) ? mod.Getter : null;
    }

    public PluginMetadata? Find(PluginKey key) =>
        Plugins.FirstOrDefault(p =>
            p.Name.Equals(key.Name, StringComparison.OrdinalIgnoreCase)
            && p.Origin.Equals(key.Origin, StringComparison.OrdinalIgnoreCase));

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

        ILoadedMod? mod = null;
        try
        {
            // The binary path — the "binary is for untracked plugins" overlay (ADR-0007
            // amendment) — needs the same explicit strings parameters Track does, or a Localized
            // untracked plugin throws instead of opening.
            var importTimer = Stopwatch.StartNew();
            mod = _adapter.OpenForRead(
                new ModPath(ModKey.FromFileName(plugin.Name), plugin.Path), GameRelease,
                new PluginStrings(ModFolders.Of(plugin.Origin, plugin.Path), DataFolderPath));
            var importMs = importTimer.ElapsedMilliseconds;

            var metadataTimer = Stopwatch.StartNew();
            var metadata = BuildPluginMetadata(mod.Getter, plugin);
            var metadataMs = metadataTimer.ElapsedMilliseconds;

            Hold(mod, metadata);

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("{FileName}: {RecordCount} records, masters: [{Masters}]",
                    plugin.Name, metadata.RecordCount, string.Join(", ", metadata.Masters));
            }
            // Per-phase timing — the binary open is lazy, so the record count in
            // BuildPluginMetadata is where most of the parse cost actually lands.
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("{FileName} opened in {ImportMs} ms + {MetadataMs} ms metadata",
                    plugin.Name, importMs, metadataMs);
            }
            return metadata;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to open plugin {FileName} ({Origin}); it is held in an error state", plugin.Name, plugin.Origin);
            SetFailure(plugin.Key, PluginLoadFailure.ReasonFor(ex));
            mod?.Dispose();
            return null;
        }
    }

    // Republishes the snapshot readers see, so a copy is never half-held from a reader's point of
    // view. Replaces any copy already held under the same key: two PluginMetadata under one
    // (origin, filename) would make every keyed lookup ambiguous.
    private void Hold(ILoadedMod mod, PluginMetadata metadata)
    {
        lock (_mutation)
        {
            var key = KeyOf(metadata.Origin, metadata.Name);
            if (_modsByKey.Remove(key, out var stale))
            {
                stale.Dispose();
                _plugins.RemoveAll(p => KeyOf(p.Origin, p.Name).Equals(key, StringComparison.OrdinalIgnoreCase));
            }
            _modsByKey[key] = mod;
            _plugins.Add(metadata);
            PublishPlugins();
            _loadFailures.Remove(key);
            Volatile.Write(ref _loadFailuresSnapshot, [.. _loadFailures.Values]);
        }
    }

    // Both views of what is held are republished together, under _mutation, so a reader can never
    // see a copy in one and not the other.
    private void PublishPlugins()
    {
        Volatile.Write(ref _pluginsSnapshot, [.. _plugins]);
        Volatile.Write(ref _openedSnapshot, _plugins.ToDictionary(p => p.Key, p => p.Content, PluginKey.Comparer));
    }

    /// <summary>The load order's half of a copy leaving the snapshot. The index side is
    /// the Index's own unregister: the rows stay for the next snapshot that wants them.</summary>
    public bool Remove(PluginKey key)
    {
        lock (_mutation)
        {
            var joined = KeyOf(key);
            var removed = _plugins.RemoveAll(p => KeyOf(p.Origin, p.Name).Equals(joined, StringComparison.OrdinalIgnoreCase)) > 0;
            if (_modsByKey.Remove(joined, out var mod)) mod.Dispose();
            if (_loadFailures.Remove(joined))
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
            var index = _plugins.FindIndex(p =>
                p.Name.Equals(previous.Name, StringComparison.OrdinalIgnoreCase)
                && p.Origin.Equals(previous.Origin, StringComparison.OrdinalIgnoreCase));
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
    internal void SetFailure(PluginKey key, string reason)
    {
        ArgumentNullException.ThrowIfNull(key.Origin);
        lock (_mutation)
        {
            _loadFailures[KeyOf(key)] = new PluginLoadFailure(key.Name, key.Origin, reason);
            Volatile.Write(ref _loadFailuresSnapshot, [.. _loadFailures.Values]);
        }
    }

    private PluginMetadata BuildPluginMetadata(IModGetter mod, RegisteredCopy plugin)
    {
        var masters = mod.MasterReferences
            .Select(r => r.Master.FileName.ToString())
            .ToList();

        return new PluginMetadata(
            Name: plugin.Name,
            Path: plugin.Path,
            LoadOrderIndex: plugin.Registration.LoadOrderIndex,
            IsLight: PluginFlagPredicates.IsLight(mod, plugin.Name),
            IsMaster: PluginFlagPredicates.IsMaster(mod, plugin.Name),
            Masters: masters,
            RecordCount: ReachableRecordCount(mod, plugin.Name),
            IsForced: plugin.IsForced,
            Origin: plugin.Origin,
            Enabled: plugin.Registration.Enabled,
            Winning: plugin.Registration.Winning);
    }

    // A group whose location scan Mutagen refuses stops the walk, and the count is a readout, not a
    // gate: the plugin opens on what was reachable and the ingest reports the type that was not.
    private int ReachableRecordCount(IModGetter mod, string plugin)
    {
        var count = 0;
        try
        {
            foreach (var _ in mod.EnumerateMajorRecords()) count++;
        }
        catch (Exception ex)
        {
            // The ingest walks the same records per type and reports the one it could not finish,
            // so this only keeps a readout from becoming a refusal to open the plugin.
            _logger.LogWarning(ex,
                "Could not walk all of {Plugin}'s records for its count; reporting the {Count} that were reachable",
                plugin, count);
        }
        return count;
    }

    /// <summary>Idempotent: a cancelled reconcile and the projector's own teardown can both reach here
    /// for one load order, and disposing a Mutagen overlay twice is not benign.</summary>
    public void Dispose()
    {
        lock (_mutation)
        {
            foreach (var mod in _modsByKey.Values)
            {
                // Stryker disable once Statement : verifying per-mod disposal requires OS-level resource checks beyond the public API
                mod.Dispose();
            }
            _modsByKey.Clear();
        }
    }
}
