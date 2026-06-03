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
    private readonly ILinkCache _linkCache;

    public string DataFolderPath { get; }
    public GameRelease GameRelease { get; }
    public IReadOnlyList<PluginMetadata> Plugins => _plugins;
    public ILinkCache LinkCache => _linkCache;

    public IModGetter? GetMod(string pluginName) =>
        _modsByName.TryGetValue(pluginName, out var mod) ? mod : null;

    public GameSession(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease, ILogger? logger = null)
    {
        logger ??= NullLogger.Instance;
        DataFolderPath = dataFolderPath;
        GameRelease = gameRelease;

        var implicitKeys = Implicits.Get(gameRelease).Listings
            .Select(k => k.FileName.ToString())
            .Where(name => File.Exists(Path.Combine(dataFolderPath, name)))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var explicitListings = PluginListings.RawLoadOrderListingsFromPath(pluginsTxtPath, gameRelease)
            .Where(l => l.Enabled)
            .ToList();

        var combined = implicitKeys
            .Concat(explicitListings
                .Select(l => l.FileName.ToString())
                .Where(name => !implicitKeys.Contains(name)))
            .ToList();

        logger.LogInformation("Load order: {Count} plugin(s) ({Implicit} implicit)",
            combined.Count, implicitKeys.Count);

        var modListings = new List<IModListing<IModGetter>>(combined.Count);

        for (int i = 0; i < combined.Count; i++)
        {
            var fileName = combined[i];
            var filePath = Path.Combine(dataFolderPath, fileName);
            if (!File.Exists(filePath))
            {
                logger.LogWarning("Plugin file not found, skipping: {FilePath}", filePath);
                continue;
            }

            var isImmutable = implicitKeys.Contains(fileName);

            logger.LogInformation("[{Index}] Opening binary overlay: {FileName} (immutable={Immutable})",
                i, fileName, isImmutable);

            var modKey = ModKey.FromFileName(fileName);
            var modPath = new ModPath(modKey, filePath);
            var mod = ModFactory.ImportGetter(modPath, gameRelease);

            logger.LogInformation("[{Index}] Overlay open. Counting records: {FileName}", i, fileName);

            _mods.Add(mod);
            _modsByName[fileName] = mod;
            modListings.Add(new ModListing<IModGetter>(mod, enabled: true));

            var masters = mod.MasterReferences
                .Select(r => r.Master.FileName.ToString())
                .ToList();

            var recordCount = mod.EnumerateMajorRecords().Count();
            logger.LogInformation("[{Index}] {FileName}: {RecordCount} records, masters: [{Masters}]",
                i, fileName, recordCount, string.Join(", ", masters));

            _plugins.Add(new PluginMetadata(
                Name: fileName,
                Path: filePath,
                LoadOrderIndex: i,
                IsLight: fileName.EndsWith(".esl", StringComparison.OrdinalIgnoreCase),
                IsMaster: fileName.EndsWith(".esm", StringComparison.OrdinalIgnoreCase),
                Masters: masters,
                RecordCount: recordCount,
                IsImmutable: isImmutable
            ));
        }

        logger.LogInformation("Building load order and link cache for {Count} plugin(s)", modListings.Count);
        var loadOrder = new LoadOrder<IModListing<IModGetter>>(modListings);
        _linkCache = loadOrder.ToUntypedImmutableLinkCache(gameRelease.ToCategory());
        logger.LogInformation("GameSession ready");
    }

    public PluginMetadata AddPlugin(string filePath)
    {
        var fileName = Path.GetFileName(filePath);
        var modKey = ModKey.FromFileName(fileName);
        var modPath = new ModPath(modKey, filePath);
        var mod = ModFactory.ImportGetter(modPath, GameRelease);

        var masters = mod.MasterReferences
            .Select(r => r.Master.FileName.ToString())
            .ToList();

        var loadOrderIndex = _mods.Count;
        _mods.Add(mod);
        _modsByName[fileName] = mod;

        var metadata = new PluginMetadata(
            Name: fileName,
            Path: filePath,
            LoadOrderIndex: loadOrderIndex,
            IsLight: fileName.EndsWith(".esl", StringComparison.OrdinalIgnoreCase),
            IsMaster: fileName.EndsWith(".esm", StringComparison.OrdinalIgnoreCase),
            Masters: masters,
            RecordCount: mod.EnumerateMajorRecords().Count(),
            IsImmutable: false
        );

        _plugins.Add(metadata);
        return metadata;
    }

    public void Dispose()
    {
        foreach (var mod in _mods)
            mod.Dispose();
    }
}
