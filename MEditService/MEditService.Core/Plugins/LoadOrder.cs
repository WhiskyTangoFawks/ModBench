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

/// <summary>
/// One plugin copy as the snapshot resolves it on this side of the boundary: the copy's identity
/// and path, whether the game forces it on regardless of <c>plugins.txt</c> (a vanilla master, a
/// Creation Club plugin — always from the game directory, always <see cref="PluginOrigin.DataDirectory"/>),
/// and the <see cref="Registration"/> it will hold. Built by <see cref="LoadOrder.Resolve"/>, which
/// is where forced plugins are prepended and every snapshot slot is offset past them.
/// </summary>
public sealed record ResolvedPlugin(string Name, string Path, string Origin, bool IsForced, Registration Registration)
{
    public PluginKey Key => new(Name, Origin);
}

/// <summary>
/// The plugin copies Editing holds (ADR-0044): each one's opened binary overlay (for metadata and
/// the write path's link cache), its <see cref="PluginMetadata"/>, and the failures of the copies
/// that could not be opened. Mutated in place by <see cref="LoadOrderMirror.Reconcile"/> — a copy
/// arrives (<see cref="Open"/>), leaves (<see cref="Remove"/>), or has its registration moved
/// (<see cref="Update"/>) — and never torn down as a whole for a change in what it holds.
/// </summary>
public sealed class LoadOrder : ILoadOrder
{
    // ADR-0036: keyed by the compound (origin, filename) identity, not the filename alone —
    // two physical copies of one filename are ordinarily held at once (ADR-0044), and a
    // filename-keyed dictionary would silently drop one. The key is a joined string rather than
    // a tuple purely so one OrdinalIgnoreCase comparer covers both halves; NUL can't occur in
    // either, so the join is unambiguous.
    private readonly Dictionary<string, IModDisposeGetter> _modsByKey = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<PluginMetadata> _plugins = [];
    private readonly Dictionary<string, PluginLoadFailure> _loadFailures = new(StringComparer.OrdinalIgnoreCase);
    private readonly ILogger _logger;

    private static string KeyOf(string origin, string name) => $"{origin}\0{name}";
    private static string KeyOf(PluginKey key) => KeyOf(key.Origin!, key.Name);

    // The load order is read while it is being reconciled, so everything a reader touches is
    // published as an immutable snapshot rather than as the live collection. Copy-on-write, not
    // copy-on-read: opening a plugin happens a few hundred times per cold reconcile, while
    // GetPlugins, PluginOriginResolver and BuildTypedLinkCache walk these lists on
    // essentially every request. Without this, a read that merely coincided with a plugin landing
    // threw "Collection was modified" — a load-order-sized race, not a rare one.
    private readonly Lock _mutation = new();
    private PluginMetadata[] _pluginsSnapshot = [];
    private PluginLoadFailure[] _loadFailuresSnapshot = [];

    public string DataFolderPath { get; }
    public string? InstanceRoot { get; }
    public GameRelease GameRelease { get; }
    public IReadOnlyList<PluginMetadata> Plugins => Volatile.Read(ref _pluginsSnapshot);
    public IReadOnlyList<PluginLoadFailure> LoadFailures => Volatile.Read(ref _loadFailuresSnapshot);
    public string? FilterSql { get; set; }

    public LoadOrder(string dataFolderPath, string? instanceRoot, GameRelease gameRelease, ILogger? logger = null)
    {
        _logger = logger ?? NullLogger.Instance;
        DataFolderPath = dataFolderPath;
        InstanceRoot = instanceRoot;
        GameRelease = gameRelease;
    }

    /// <summary>
    /// Resolves a snapshot to the copies this side will hold: the game's implicit masters and its
    /// Creation Club catalog first (forced on, from <paramref name="gameDirectory"/>, never a mod),
    /// then every snapshot entry whose name is not forced, in snapshot order, with its slot offset
    /// past the forced block so a forced master always sorts before everything <c>plugins.txt</c>
    /// lists. Both forced sources dedupe the same way: a name either of them claims is forced on
    /// regardless of what the snapshot says about it — a CC plugin Mod Management also sent
    /// as an ordinary line is held exactly once, from the game directory.
    /// </summary>
    public static IReadOnlyList<ResolvedPlugin> Resolve(
        string gameDirectory, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> entries)
    {
        var implicitKeys = ResolveImplicitKeys(gameDirectory, gameRelease);
        var creationClubNames = ResolveCreationClubNames(gameDirectory, gameRelease);
        var forcedNames = new HashSet<string>(implicitKeys, StringComparer.OrdinalIgnoreCase);
        forcedNames.UnionWith(creationClubNames);

        var forced = implicitKeys.Concat(creationClubNames)
            .Select((name, i) => new ResolvedPlugin(
                name, Path.Combine(gameDirectory, name), PluginOrigin.DataDirectory, IsForced: true,
                Registration.Participating(i)))
            .ToList();
        var offset = forced.Count;

        return
        [
            .. forced,
            .. entries
                .Where(e => !forcedNames.Contains(e.Name))
                .Select(e => new ResolvedPlugin(
                    e.Name, e.Path, e.Origin, IsForced: false,
                    new Registration(e.Slot is { } slot ? offset + slot : null, e.Enabled, e.Winning))),
        ];
    }

    private static HashSet<string> ResolveImplicitKeys(string folder, GameRelease gameRelease) =>
        Implicits.Get(gameRelease).Listings
            .Select(k => k.FileName.ToString())
            .Where(name => File.Exists(Path.Combine(folder, name)))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Names cataloged in the game's own <c>[Category].ccc</c> — Creation Club content the
    /// game loads independent of <c>plugins.txt</c>'s `*` toggles, the same way DLC `.esm`s always
    /// load. Mutagen's own reader already filters to entries whose file exists in
    /// <paramref name="folder"/>, so a stale or hand-edited catalog entry naming a file that isn't
    /// there contributes nothing — no re-check needed here. <see cref="CreationClubListings.GetListingsPath"/>
    /// is per-<see cref="GameCategory"/>, not this game specifically, so a category with no CC
    /// concept (or an install with no catalog file) yields empty rather than throwing:
    /// <c>LoadOrderListingsFromPath</c>'s own <c>Get()</c> throws if the file it's given doesn't
    /// exist, which is exactly why existence is checked first rather than left to it. Order is the
    /// catalog's own file order — not alphabetized, not re-sorted — because catalog order is what
    /// the caller places the block in relative to <c>plugins.txt</c>.
    /// </summary>
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

    /// <summary>The held copy <paramref name="key"/> names, or null when this load order does not
    /// hold it (never opened, failed to open, or removed).</summary>
    public PluginMetadata? Find(PluginKey key) =>
        Plugins.FirstOrDefault(p =>
            p.Name.Equals(key.Name, StringComparison.OrdinalIgnoreCase)
            && p.Origin.Equals(key.Origin, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Opens one resolved copy's binary overlay and holds it. Opening is not free —
    /// <see cref="BuildPluginMetadata"/> counts the plugin's records — which is why the reconcile
    /// interleaves it with indexing rather than opening everything first (ADR-0035).
    /// A copy that cannot be opened or parsed (an unparseable record, a missing file) must not abort
    /// the whole reconcile: it is recorded in <see cref="LoadFailures"/> and null is returned, and
    /// nothing is held for it. A success clears any earlier failure for the same copy.
    /// </summary>
    public PluginMetadata? Open(ResolvedPlugin plugin)
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

    /// <summary>Holds an opened plugin and republishes the snapshot readers see, so a copy is never
    /// half-held from a reader's point of view. Replaces any copy already held under the same key
    /// rather than appending beside it — two PluginMetadata under one (origin, filename) makes every
    /// ColumnKey-keyed lookup ambiguous.</summary>
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

    /// <summary>Drops a held copy — its overlay disposed, its metadata gone — the load order's half
    /// of a copy leaving the snapshot. The index side is <c>IRecordIndex.Unregister</c>: the rows
    /// stay for the next snapshot that wants them. Returns false when nothing was held.</summary>
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

    /// <summary>
    /// Moves a held copy's registration in place — the load order's half of a reconcile that
    /// changed a slot or a flag (a reorder, an enable, a change of which copy wins). Nothing here
    /// opens or re-reads the plugin file: none of the three facts is a property of the file's
    /// content, and re-deriving anything else here would let a reconcile silently re-read.
    /// </summary>
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

    /// <summary>
    /// ADR-0041: the New Plugin gesture — opens a freshly written file whose destination is a
    /// mod folder (or MO2's overwrite/) that Mod Management resolved. A created plugin is a genuine
    /// load-order member from the moment it is held (winning, enabled, at the slot one past the
    /// highest in use) even though <c>plugins.txt</c> has not been appended yet: that append is the
    /// caller's job, and the next snapshot corrects the slot to the real line. One past the highest
    /// slot, not <c>Plugins.Count</c>: a removal can shrink the list, and a reused slot would
    /// give two participating plugins the same load_order_idx — an ambiguous stack.
    /// </summary>
    public PluginMetadata AddCreatedPlugin(string filePath, string origin)
    {
        var nextIndex = _plugins.Count == 0 ? 0 : _plugins.Max(p => p.LoadOrderIndex ?? 0) + 1;
        var fileName = Path.GetFileName(filePath);
        var mod = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(fileName), filePath), GameRelease,
            LocalizedStrings.ForRead(ModFolders.Of(origin, filePath), DataFolderPath));
        var metadata = BuildPluginMetadata(
            mod, new ResolvedPlugin(fileName, filePath, origin, IsForced: false, Registration.Participating(nextIndex)));
        Hold(mod, metadata);
        return metadata;
    }

    /// <summary>Lets the mirror report a post-open failure (an indexing throw from malformed record
    /// data Mutagen can't parse) through the same channel as open failures.</summary>
    internal void SetFailure(PluginKey key, string reason)
    {
        lock (_mutation)
        {
            _loadFailures[KeyOf(key)] = new PluginLoadFailure(key.Name, reason);
            Volatile.Write(ref _loadFailuresSnapshot, [.. _loadFailures.Values]);
        }
    }

    private static PluginMetadata BuildPluginMetadata(IModGetter mod, ResolvedPlugin plugin)
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
            RecordCount: mod.EnumerateMajorRecords().Count(),
            IsForced: plugin.IsForced,
            Origin: plugin.Origin,
            Enabled: plugin.Registration.Enabled,
            Winning: plugin.Registration.Winning);
    }

    /// <summary>
    /// Idempotent: a cancelled reconcile and the mirror's own teardown can both reach here for one
    /// load order. Disposing a Mutagen overlay twice is not benign.
    /// </summary>
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
