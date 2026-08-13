using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Order;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Session;

public sealed class GameSession : IGameSession
{
    private readonly List<IModDisposeGetter> _mods = [];
    // #34 / ADR-0036: keyed by the compound (origin, filename) identity, not the filename alone —
    // two physical copies of one filename can be open at once (a load-order copy plus a shadowed
    // one loaded on demand), and a filename-keyed dictionary silently dropped the first. The key
    // is a joined string rather than a tuple purely so one OrdinalIgnoreCase comparer covers both
    // halves; NUL can't occur in either, so the join is unambiguous.
    private readonly Dictionary<string, IModGetter> _modsByKey = new(StringComparer.OrdinalIgnoreCase);

    private static string KeyOf(string origin, string name) => $"{origin}\0{name}";
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
    public string? FilterSql { get; set; }

    public IModGetter? GetMod(string pluginName, string origin) =>
        _modsByKey.TryGetValue(KeyOf(origin, pluginName), out var mod) ? mod : null;

    private sealed record ResolvedPlugin(string FileName, string FilePath, bool IsImmutable, bool Participates, string Origin);

    public GameSession(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease, ILogger? logger = null)
        : this(dataFolderPath, gameRelease, ResolveFromDataFolder(dataFolderPath, pluginsTxtPath, gameRelease), logger)
    {
    }

    /// <summary>
    /// Builds a session from an ordered list of scattered physical plugin paths (an MO2-style
    /// instance's enabled plugins), with the game's implicit masters resolved from
    /// <paramref name="gameDirectory"/>. Implicit masters are ordered first and treated as immutable;
    /// each explicit entry whose name is not an implicit master follows in the given order. Each
    /// explicit plugin also carries the origin Mod Management resolved it from — a mod folder name,
    /// or a PluginOrigin reserved value (#269 / ADR-0036) — and whether it participates in winner
    /// computation, i.e. its plugins.txt `*` prefix (#270 / ADR-0035).
    /// </summary>
    public static GameSession LoadExplicit(
        string gameDirectory, IReadOnlyList<(string Name, string Path, string Origin, bool Participates)> plugins, GameRelease gameRelease, ILogger? logger = null)
    {
        var implicitKeys = ResolveImplicitKeys(gameDirectory, gameRelease);

        // The explicit list is every plugins.txt line, enabled and disabled alike (#270 /
        // ADR-0035) — the caller states participation per plugin, because the `*` prefix is the
        // only thing that carries it and there is no plugins.txt on this path to read it from.
        // Implicit masters are forced on: they have no line to be disabled by. They are also
        // always resolved from the game directory itself, never a mod, so their origin is always
        // the reserved Data-directory value regardless of what the caller supplied.
        var ordered = implicitKeys
            .Select(name => new ResolvedPlugin(name, Path.Combine(gameDirectory, name), IsImmutable: true, Participates: true, Origin: PluginOrigin.DataDirectory))
            .Concat(plugins
                .Where(p => !implicitKeys.Contains(p.Name))
                .Select(p => new ResolvedPlugin(p.Name, p.Path, IsImmutable: false, Participates: p.Participates, Origin: p.Origin)))
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
                var metadata = BuildPluginMetadata(mod, ordered[i], i);

                _mods.Add(mod);
                _modsByKey[KeyOf(origin, fileName)] = mod;
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

        logger.LogDebug("GameSession ready: {Count} plugin(s) open", _plugins.Count);
    }

    public PluginMetadata AddPlugin(string filePath)
    {
        // A plugin created via AddPlugin is appended to plugins.txt with the `*` prefix
        // (SessionManager.CreatePlugin) — it always participates. It is also always written
        // directly into the session's data folder, never a mod folder, so its origin is always
        // the reserved Data-directory value (#269 / ADR-0036).
        // One past the highest index in use, not _mods.Count: RemoveUnlistedPlugin can shrink that
        // list (#34), and a reused index would give two *participating* plugins the same
        // load_order_idx — UpdateWinners takes MAX(load_order_idx), so both would win a FormKey
        // they share.
        var nextIndex = _plugins.Count == 0 ? 0 : _plugins.Max(p => p.LoadOrderIndex) + 1;
        return Open(filePath, PluginOrigin.DataDirectory, nextIndex, isImmutable: false, participates: true);
    }

    /// <summary>
    /// Opens a plugin file the load order does not name — a copy shadowed by a higher-priority
    /// mod, or a file <c>plugins.txt</c> never lists — on demand, mid-session (#34 / ADR-0035).
    /// It is read-only (ADR-0036: editing a file the game does not load changes nothing anywhere)
    /// and never participates in winner computation, so it can arrive late without invalidating
    /// any classification already on screen.
    /// </summary>
    /// <param name="loadOrderIndex">
    /// The index it is compared *against* — the load-order copy of the same filename, so the two
    /// land adjacent in the compare grid, which orders columns by it. It never decides a winner:
    /// non-participating rows are excluded from the winner sweep by the `plugins` join, not by
    /// their index.
    /// </param>
    public PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex)
    {
        // Idempotent: the visibility toggle re-issues load for everything it discovered, so asking
        // for a copy that is already open is an ordinary event rather than a caller error. Opening
        // it twice would append a second PluginMetadata under the same (origin, filename), which
        // makes every ColumnKey-keyed lookup ambiguous — GetCompare's own dictionaries throw on the
        // pair — and would leak the first IModGetter.
        var already = _plugins.FirstOrDefault(p =>
            !p.InLoadOrder
            && p.Name.Equals(Path.GetFileName(filePath), StringComparison.OrdinalIgnoreCase)
            && p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase));
        return already ?? Open(filePath, origin, loadOrderIndex, isImmutable: true, participates: false, inLoadOrder: false);
    }

    /// <summary>
    /// Closes a plugin the load order does not name and forgets it (#34 / ADR-0035) — the inverse
    /// of <see cref="AddUnlistedPlugin"/>. Load-order members are refused: dropping one would
    /// change which file a filename resolves to underneath staged edits, which is a session reload,
    /// not a visibility toggle. Returns false when no such copy is open.
    /// </summary>
    public bool RemoveUnlistedPlugin(string pluginName, string origin)
    {
        var metadata = _plugins.FirstOrDefault(p =>
            !p.InLoadOrder
            && p.Name.Equals(pluginName, StringComparison.OrdinalIgnoreCase)
            && p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase));
        if (metadata == null) return false;

        if (_modsByKey.Remove(KeyOf(origin, metadata.Name), out var mod) && mod is IDisposable disposable)
        {
            _mods.Remove((IModDisposeGetter)mod);
            disposable.Dispose();
        }

        _plugins.Remove(metadata);
        return true;
    }

    private PluginMetadata Open(
        string filePath, string origin, int loadOrderIndex, bool isImmutable, bool participates, bool inLoadOrder = true)
    {
        var fileName = Path.GetFileName(filePath);
        var modKey = ModKey.FromFileName(fileName);
        var modPath = new ModPath(modKey, filePath);
        var mod = ModFactory.ImportGetter(modPath, GameRelease);

        _mods.Add(mod);
        _modsByKey[KeyOf(origin, fileName)] = mod;

        // No Mutagen LoadOrder or link cache is built here or anywhere else in this class: reads
        // answer from the DuckDB index (ADR-0025), and the write path builds its own typed cache
        // per save from the load-order members only (SessionManager.BuildTypedLinkCache). That
        // matters for this method in particular — Mutagen's LoadOrder is keyed by ModKey and
        // refuses a second listing for a filename it already holds.
        var metadata = BuildPluginMetadata(
            mod, new ResolvedPlugin(fileName, filePath, isImmutable, participates, origin), loadOrderIndex, inLoadOrder);
        _plugins.Add(metadata);
        return metadata;
    }

    private static PluginMetadata BuildPluginMetadata(
        IModGetter mod, ResolvedPlugin plugin, int loadOrderIndex, bool inLoadOrder = true)
    {
        var (fileName, filePath, isImmutable, participates, origin) = plugin;

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
            Participates: participates,
            InLoadOrder: inLoadOrder
        );
    }

    public void Dispose()
    {
        foreach (var mod in _mods)
        {
            // Stryker disable once Statement : verifying per-mod disposal requires OS-level resource checks beyond the public API
            mod.Dispose();
        }
    }
}
