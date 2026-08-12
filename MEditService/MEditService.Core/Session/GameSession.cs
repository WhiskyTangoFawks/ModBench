using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Order;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Session;

public sealed class GameSession : IGameSession
{
    private readonly List<IModDisposeGetter> _mods = [];
    private readonly Dictionary<string, IModGetter> _modsByName = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<PluginMetadata> _plugins = [];
    private readonly List<PluginLoadFailure> _loadFailures = [];

    public string DataFolderPath { get; }
    public GameRelease GameRelease { get; }
    public IReadOnlyList<PluginMetadata> Plugins => _plugins;
    public IReadOnlyList<PluginLoadFailure> LoadFailures => _loadFailures;

    // Lets SessionManager report a post-open failure (e.g. an indexing throw from malformed
    // record data Mutagen can't parse) through the same partial-success channel as the
    // ImportGetter failures captured below, without re-opening the whole load order.
    internal void RecordIndexFailure(string pluginName, string reason) =>
        _loadFailures.Add(new PluginLoadFailure(pluginName, reason));
    public ILinkCache LinkCache { get; }
    public string? FilterSql { get; set; }

    public IModGetter? GetMod(string pluginName) =>
        _modsByName.TryGetValue(pluginName, out var mod) ? mod : null;

    private sealed record ResolvedPlugin(string FileName, string FilePath, bool IsImmutable, bool Participates, string Origin);

    public GameSession(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease, ILogger? logger = null)
        : this(dataFolderPath, gameRelease, ResolveFromDataFolder(dataFolderPath, pluginsTxtPath, gameRelease), logger)
    {
    }

    /// <summary>
    /// Builds a session from an ordered list of scattered physical plugin paths (an MO2-style
    /// instance's enabled plugins), with the game's implicit masters resolved from
    /// <paramref name="gameDirectory"/>. Implicit masters are ordered first and treated as immutable;
    /// each explicit entry whose name is not an implicit master follows in the given order.
    /// </summary>
    public static GameSession LoadExplicit(
        string gameDirectory, IReadOnlyList<(string Name, string Path)> plugins, GameRelease gameRelease, ILogger? logger = null) =>
        // This overload has no way to know a real origin for its scattered paths — every remaining
        // caller is a test fixture that asserts nothing about Origin (#269 / ADR-0036), so default
        // to the reserved Data-directory value rather than leave it null. Real (MO2-backed) session
        // loads go through the overload below instead.
        LoadExplicit(gameDirectory, plugins.Select(p => (p.Name, p.Path, PluginOrigin.DataDirectory)).ToList(), gameRelease, logger);

    /// <summary>
    /// Same contract as the (Name, Path) overload above, but each explicit plugin also carries the
    /// origin Mod Management resolved it from — a mod folder name, or a PluginOrigin reserved value
    /// (#269 / ADR-0036).
    /// </summary>
    public static GameSession LoadExplicit(
        string gameDirectory, IReadOnlyList<(string Name, string Path, string Origin)> plugins, GameRelease gameRelease, ILogger? logger = null)
    {
        var implicitKeys = ResolveImplicitKeys(gameDirectory, gameRelease);

        // LoadExplicit takes an already-enabled list (an MO2 profile's active plugins) — there is
        // no plugins.txt here to carry a disabled entry, so every resolved plugin participates.
        // Implicit masters are always resolved from the game directory itself, never a mod, so
        // their origin is always the reserved Data-directory value regardless of what the caller
        // supplied for the explicit list.
        var ordered = implicitKeys
            .Select(name => new ResolvedPlugin(name, Path.Combine(gameDirectory, name), IsImmutable: true, Participates: true, Origin: PluginOrigin.DataDirectory))
            .Concat(plugins
                .Where(p => !implicitKeys.Contains(p.Name))
                .Select(p => new ResolvedPlugin(p.Name, p.Path, IsImmutable: false, Participates: true, Origin: p.Origin)))
            .ToList();

        return new GameSession(gameDirectory, gameRelease, ordered, logger);
    }

    private static HashSet<string> ResolveImplicitKeys(string folder, GameRelease gameRelease) =>
        Implicits.Get(gameRelease).Listings
            .Select(k => k.FileName.ToString())
            .Where(name => File.Exists(Path.Combine(folder, name)))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    private static List<ResolvedPlugin> ResolveFromDataFolder(
        string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease)
    {
        var implicitKeys = ResolveImplicitKeys(dataFolderPath, gameRelease);

        // #267 / ADR-0035: every non-comment, non-blank plugins.txt entry is indexed — enabled and
        // disabled alike. The `*` prefix (Enabled) becomes Participates, not a filter on presence.
        var explicitListings = PluginListings.RawLoadOrderListingsFromPath(pluginsTxtPath, gameRelease)
            .Where(l => !implicitKeys.Contains(l.FileName));

        // Every plugin here is physically inside dataFolderPath — there is no MO2 VFS in this
        // constructor path, so every plugin's origin is the reserved Data-directory value (#269 / ADR-0036).
        return
        [
            .. implicitKeys
                        .Select(name => new ResolvedPlugin(name, Path.Combine(dataFolderPath, name), IsImmutable: true, Participates: true, Origin: PluginOrigin.DataDirectory)),
            .. explicitListings
                    .Select(l => new ResolvedPlugin(l.FileName, Path.Combine(dataFolderPath, l.FileName), IsImmutable: false, Participates: l.Enabled, Origin: PluginOrigin.DataDirectory)),
        ];
    }

    private GameSession(string dataFolderPath, GameRelease gameRelease, IReadOnlyList<ResolvedPlugin> ordered, ILogger? logger)
    {
        logger ??= NullLogger.Instance;
        DataFolderPath = dataFolderPath;
        GameRelease = gameRelease;

        logger.LogDebug("Load order: {Count} plugin(s) ({Implicit} immutable)",
            ordered.Count, ordered.Count(p => p.IsImmutable));

        var modListings = new List<IModListing<IModGetter>>(ordered.Count);

        for (int i = 0; i < ordered.Count; i++)
        {
            var (fileName, filePath, isImmutable, participates, origin) = ordered[i];
            if (!File.Exists(filePath))
            {
                logger.LogWarning("Plugin file not found, skipping: {FilePath}", filePath);
                continue;
            }

            logger.LogInformation("[{Index}] Opening binary overlay: {FileName} (immutable={Immutable}, participates={Participates})",
                i, fileName, isImmutable, participates);

            var modKey = ModKey.FromFileName(fileName);
            var modPath = new ModPath(modKey, filePath);

            // A single plugin that cannot be opened or parsed (e.g. an unparseable record) must not
            // abort the whole load order: skip it, record the failure, and carry on. Metadata is built
            // before the mod is registered so a parse failure leaves nothing partially loaded.
            IModDisposeGetter? mod = null;
            try
            {
                mod = ModFactory.ImportGetter(modPath, gameRelease);
                var metadata = BuildPluginMetadata(mod, fileName, filePath, i, isImmutable, participates, origin);

                _mods.Add(mod);
                _modsByName[fileName] = mod;
                // Stryker disable once Boolean : ToUntypedImmutableLinkCache reads listing.Mod directly and ignores the enabled flag
                modListings.Add(new ModListing<IModGetter>(mod, enabled: true));
                _plugins.Add(metadata);

                logger.LogInformation("[{Index}] {FileName}: {RecordCount} records, masters: [{Masters}]",
                    i, fileName, metadata.RecordCount, string.Join(", ", metadata.Masters));
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "[{Index}] Failed to load plugin {FileName}; skipping", i, fileName);
                _loadFailures.Add(new PluginLoadFailure(fileName, ex.Message));
                mod?.Dispose();
            }
        }

        logger.LogDebug("Building load order and link cache for {Count} plugin(s)", modListings.Count);
        var loadOrder = new LoadOrder<IModListing<IModGetter>>(modListings);
        LinkCache = loadOrder.ToUntypedImmutableLinkCache(gameRelease.ToCategory());
        logger.LogDebug("GameSession ready");
    }

    public PluginMetadata AddPlugin(string filePath)
    {
        var fileName = Path.GetFileName(filePath);
        var modKey = ModKey.FromFileName(fileName);
        var modPath = new ModPath(modKey, filePath);
        var mod = ModFactory.ImportGetter(modPath, GameRelease);

        var loadOrderIndex = _mods.Count;
        _mods.Add(mod);
        _modsByName[fileName] = mod;

        // A plugin created via AddPlugin is appended to plugins.txt with the `*` prefix
        // (SessionManager.CreatePlugin) — it always participates. It is also always written
        // directly into the session's data folder, never a mod folder, so its origin is always
        // the reserved Data-directory value (#269 / ADR-0036).
        var metadata = BuildPluginMetadata(mod, fileName, filePath, loadOrderIndex, isImmutable: false, participates: true, origin: PluginOrigin.DataDirectory);
        _plugins.Add(metadata);
        return metadata;
    }

    private static PluginMetadata BuildPluginMetadata(
        IModGetter mod, string fileName, string filePath, int loadOrderIndex, bool isImmutable, bool participates, string origin)
    {
        var masters = mod.MasterReferences
            .Select(r => r.Master.FileName.ToString())
            .ToList();

        return new PluginMetadata(
            Name: fileName,
            Path: filePath,
            LoadOrderIndex: loadOrderIndex,
            IsLight: fileName.EndsWith(".esl", StringComparison.OrdinalIgnoreCase),
            IsMaster: fileName.EndsWith(".esm", StringComparison.OrdinalIgnoreCase),
            Masters: masters,
            RecordCount: mod.EnumerateMajorRecords().Count(),
            IsImmutable: isImmutable,
            Origin: origin,
            Participates: participates
        );
    }

    public void Dispose()
    {
        foreach (var mod in _mods)
        {
            // Stryker disable once Statement : verifying per-mod disposal requires OS-level resource checks beyond the public API
            mod.Dispose();
        }
        (LinkCache as IDisposable)?.Dispose();
    }
}
