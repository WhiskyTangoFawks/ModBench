using System.Diagnostics;
using MEditService.Core.Records;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Order;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Plugins;

/// <summary>The plugin copies Editing holds (ADR-0044). Mutated in place by reconcile — a copy
/// arrives, leaves, or has its registration moved — and never torn down as a whole for a change in
/// what it holds.</summary>
public sealed class HeldPlugins : ILoadOrder
{
    // ADR-0036: keyed by the compound (origin, filename) identity — two copies of one filename are
    // ordinarily held at once, and a filename-keyed dictionary would silently drop one. Joined into
    // one string so a single OrdinalIgnoreCase comparer covers both halves.
    private readonly Dictionary<string, IModDisposeGetter> _modsByKey = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<PluginMetadata> _plugins = [];
    private readonly Dictionary<string, PluginLoadFailure> _loadFailures = new(StringComparer.OrdinalIgnoreCase);
    private readonly ILogger _logger;

    private static string KeyOf(string origin, string name) => $"{origin}\0{name}";
    private static string KeyOf(PluginKey key) => KeyOf(key.Origin!, key.Name);

    // The load order is read while it is being reconciled, so readers see an immutable snapshot.
    // Copy-on-write, not copy-on-read: opens are a few hundred per cold reconcile, while reads walk
    // these lists on every request.
    private readonly Lock _mutation = new();
    private PluginMetadata[] _pluginsSnapshot = [];
    private PluginLoadFailure[] _loadFailuresSnapshot = [];

    public string DataFolderPath { get; }
    public string? InstanceRoot { get; }
    public GameRelease GameRelease { get; }
    public IReadOnlyList<PluginMetadata> Plugins => Volatile.Read(ref _pluginsSnapshot);
    public IReadOnlyList<PluginLoadFailure> Failures => Volatile.Read(ref _loadFailuresSnapshot);

    public HeldPlugins(string dataFolderPath, string? instanceRoot, GameRelease gameRelease, ILogger? logger = null)
    {
        _logger = logger ?? NullLogger.Instance;
        DataFolderPath = dataFolderPath;
        InstanceRoot = instanceRoot;
        GameRelease = gameRelease;
    }

    /// <summary>The implicit masters and Creation Club catalog come first, forced on, and every
    /// snapshot slot is offset past them so a forced master always sorts first. A name either
    /// forced source claims is held exactly once.</summary>
    public static IReadOnlyList<RegisteredCopy> Resolve(
        string gameDirectory, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> entries)
    {
        var implicitKeys = ResolveImplicitKeys(gameDirectory, gameRelease);
        var creationClubNames = ResolveCreationClubNames(gameDirectory, gameRelease);
        var forcedNames = new HashSet<string>(implicitKeys, StringComparer.OrdinalIgnoreCase);
        forcedNames.UnionWith(creationClubNames);

        var forced = implicitKeys.Concat(creationClubNames)
            .Select((name, i) => new RegisteredCopy(
                name, PluginOrigin.DataDirectory, Path.Combine(gameDirectory, name), i, Enabled: true,
                Winning: true, IsForced: true))
            .ToList();
        var offset = forced.Count;

        return
        [
            .. forced,
            .. entries
                .Where(e => !forcedNames.Contains(e.Name))
                .Select(e => new RegisteredCopy(
                    e.Name, e.Origin, e.Path, e.Slot is { } slot ? offset + slot : null, e.Enabled, e.Winning)),
        ];
    }

    private static HashSet<string> ResolveImplicitKeys(string folder, GameRelease gameRelease) =>
        Implicits.Get(gameRelease).Listings
            .Select(k => k.FileName.ToString())
            .Where(name => File.Exists(Path.Combine(folder, name)))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    // Mutagen's reader already filters to entries whose file exists, so a stale catalog entry
    // contributes nothing. Existence is checked first because LoadOrderListingsFromPath throws on a
    // missing file. Order is the catalog's own, never re-sorted.
    private static List<string> ResolveCreationClubNames(string folder, GameRelease gameRelease)
    {
        var cccPath = CreationClubListings.GetListingsPath(gameRelease.ToCategory(), folder);
        if (cccPath is not { } path || !File.Exists(path.Path)) return [];

        return CreationClubListings.LoadOrderListingsFromPath(path, folder)
            .Select(l => l.FileName.ToString())
            .ToList();
    }

    public IModGetter? GetMod(string pluginName, string origin)
    {
        // Under the same lock as the writes: a Dictionary read concurrent with a write is not merely
        // stale, it can spin or throw. Cheap — this is per-save and per-index, not per-read.
        lock (_mutation)
            return _modsByKey.TryGetValue(KeyOf(origin, pluginName), out var mod) ? mod : null;
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

        IModDisposeGetter? mod = null;
        try
        {
            // The binary path — the "binary is for untracked plugins" overlay (ADR-0041
            // amendment) — needs the same explicit strings parameters Track does, or a Localized
            // untracked plugin throws instead of opening.
            var importTimer = Stopwatch.StartNew();
            mod = ModFactory.ImportGetter(
                new ModPath(ModKey.FromFileName(plugin.Name), plugin.Path), GameRelease,
                LocalizedStrings.ForRead(ModFolders.Of(plugin.Origin, plugin.Path), DataFolderPath));
            var importMs = importTimer.ElapsedMilliseconds;

            var metadataTimer = Stopwatch.StartNew();
            var metadata = BuildPluginMetadata(mod, plugin);
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
    private void Hold(IModDisposeGetter mod, PluginMetadata metadata)
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
            Volatile.Write(ref _pluginsSnapshot, [.. _plugins]);
            _loadFailures.Remove(key);
            Volatile.Write(ref _loadFailuresSnapshot, [.. _loadFailures.Values]);
        }
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
            if (removed) Volatile.Write(ref _pluginsSnapshot, [.. _plugins]);
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
            Volatile.Write(ref _pluginsSnapshot, [.. _plugins]);
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
        lock (_mutation)
        {
            _loadFailures[KeyOf(key)] = new PluginLoadFailure(key.Name, reason);
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
