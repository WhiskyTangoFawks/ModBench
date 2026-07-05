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
    public ILinkCache LinkCache { get; }
    public string? FilterSql { get; set; }

    public IModGetter? GetMod(string pluginName) =>
        _modsByName.TryGetValue(pluginName, out var mod) ? mod : null;

    private sealed record ResolvedPlugin(string FileName, string FilePath, bool IsImmutable);

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
        string gameDirectory, IReadOnlyList<(string Name, string Path)> plugins, GameRelease gameRelease, ILogger? logger = null)
    {
        var implicitKeys = ResolveImplicitKeys(gameDirectory, gameRelease);

        var ordered = implicitKeys
            .Select(name => new ResolvedPlugin(name, Path.Combine(gameDirectory, name), IsImmutable: true))
            .Concat(plugins
                .Where(p => !implicitKeys.Contains(p.Name))
                .Select(p => new ResolvedPlugin(p.Name, p.Path, IsImmutable: false)))
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

        var explicitNames = PluginListings.RawLoadOrderListingsFromPath(pluginsTxtPath, gameRelease)
            .Where(l => l.Enabled)
            .Select(l => l.FileName)
            .Where(name => !implicitKeys.Contains(name));

        return
        [
            .. implicitKeys
                        .Select(name => new ResolvedPlugin(name, Path.Combine(dataFolderPath, name), IsImmutable: true)),
            .. explicitNames
                    .Select(name => new ResolvedPlugin(name, Path.Combine(dataFolderPath, name), IsImmutable: false)),
        ];
    }

    private GameSession(string dataFolderPath, GameRelease gameRelease, IReadOnlyList<ResolvedPlugin> ordered, ILogger? logger)
    {
        logger ??= NullLogger.Instance;
        DataFolderPath = dataFolderPath;
        GameRelease = gameRelease;

        logger.LogInformation("Load order: {Count} plugin(s) ({Implicit} immutable)",
            ordered.Count, ordered.Count(p => p.IsImmutable));

        var modListings = new List<IModListing<IModGetter>>(ordered.Count);

        for (int i = 0; i < ordered.Count; i++)
        {
            var (fileName, filePath, isImmutable) = ordered[i];
            if (!File.Exists(filePath))
            {
                logger.LogWarning("Plugin file not found, skipping: {FilePath}", filePath);
                continue;
            }

            logger.LogInformation("[{Index}] Opening binary overlay: {FileName} (immutable={Immutable})",
                i, fileName, isImmutable);

            var modKey = ModKey.FromFileName(fileName);
            var modPath = new ModPath(modKey, filePath);

            // A single plugin that cannot be opened or parsed (e.g. an unparseable record) must not
            // abort the whole load order: skip it, record the failure, and carry on. Metadata is built
            // before the mod is registered so a parse failure leaves nothing partially loaded.
            IModDisposeGetter? mod = null;
            try
            {
                mod = ModFactory.ImportGetter(modPath, gameRelease);
                var metadata = BuildPluginMetadata(mod, fileName, filePath, i, isImmutable);

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

        logger.LogInformation("Building load order and link cache for {Count} plugin(s)", modListings.Count);
        var loadOrder = new LoadOrder<IModListing<IModGetter>>(modListings);
        LinkCache = loadOrder.ToUntypedImmutableLinkCache(gameRelease.ToCategory());
        logger.LogInformation("GameSession ready");
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

        var metadata = BuildPluginMetadata(mod, fileName, filePath, loadOrderIndex, isImmutable: false);
        _plugins.Add(metadata);
        return metadata;
    }

    private static PluginMetadata BuildPluginMetadata(
        IModGetter mod, string fileName, string filePath, int loadOrderIndex, bool isImmutable)
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
            IsImmutable: isImmutable
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
