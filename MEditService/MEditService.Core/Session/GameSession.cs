using System.Diagnostics;
using MEditService.Core.Source;
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
    private readonly IReadOnlyList<ResolvedPlugin> _ordered;
    private readonly ILogger _logger;

    // #274: a session is now read while it is still being built, so everything a reader touches is
    // published as an immutable snapshot rather than as the live collection. Copy-on-write, not
    // copy-on-read: opening a plugin happens a few hundred times per load, while GetPlugins,
    // PluginOriginResolver, RequirePlugin and BuildTypedLinkCache walk these lists on essentially
    // every request. Without this, a read that merely coincided with a plugin landing threw
    // "Collection was modified" — a load-order-sized race, not a rare one.
    private readonly Lock _mutation = new();
    private PluginMetadata[] _pluginsSnapshot = [];
    private PluginLoadFailure[] _loadFailuresSnapshot = [];

    public string DataFolderPath { get; }
    public GameRelease GameRelease { get; }

    /// <summary>How many plugins this session's resolved load order will attempt to open — the
    /// denominator for load progress (#274), known before any of them has been opened. Plugins that
    /// fail to open still count: the caller asked for them.</summary>
    public int PlannedPluginCount => _ordered.Count;
    public IReadOnlyList<PluginMetadata> Plugins => Volatile.Read(ref _pluginsSnapshot);
    public IReadOnlyList<PluginLoadFailure> LoadFailures => Volatile.Read(ref _loadFailuresSnapshot);

    // Lets SessionManager report a post-open failure (e.g. an indexing throw from malformed
    // record data Mutagen can't parse) through the same partial-success channel as the
    // ImportGetter failures captured below, without re-opening the whole load order.
    internal void RecordIndexFailure(string pluginName, string reason) =>
        AddLoadFailure(new PluginLoadFailure(pluginName, reason));

    private void AddLoadFailure(PluginLoadFailure failure)
    {
        lock (_mutation)
        {
            _loadFailures.Add(failure);
            Volatile.Write(ref _loadFailuresSnapshot, [.. _loadFailures]);
        }
    }

    /// <summary>Adds an opened plugin to the session and republishes the snapshot readers see, so a
    /// plugin is never half-registered from a reader's point of view.</summary>
    private void Register(IModDisposeGetter mod, string origin, string fileName, PluginMetadata metadata)
    {
        lock (_mutation)
        {
            _mods.Add(mod);
            _modsByKey[KeyOf(origin, fileName)] = mod;
            _plugins.Add(metadata);
            Volatile.Write(ref _pluginsSnapshot, [.. _plugins]);
        }
    }

    public string? FilterSql { get; set; }

    public IModGetter? GetMod(string pluginName, string origin)
    {
        // Under the same lock as the writes: a Dictionary read concurrent with a write is not merely
        // stale, it can spin or throw. Cheap — this is per-save and per-index, not per-read.
        lock (_mutation)
            return _modsByKey.TryGetValue(KeyOf(origin, pluginName), out var mod) ? mod : null;
    }

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
        string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease, ILogger? logger = null)
    {
        var implicitKeys = ResolveImplicitKeys(gameDirectory, gameRelease);
        var creationClubNames = ResolveCreationClubNames(gameDirectory, gameRelease);
        // Both forced sources dedupe the same way: a name either of them claims is forced on from
        // the block below regardless of what the caller's own list says about it (#434) — a CC
        // plugin Mod Management also sent as an ordinary plugins.txt line (the repro's three
        // already-*-listed ESLs) loads exactly once, from the forced block, never from its own line.
        var forcedNames = new HashSet<string>(implicitKeys, StringComparer.OrdinalIgnoreCase);
        forcedNames.UnionWith(creationClubNames);

        // The explicit list is every plugins.txt line, enabled and disabled alike (#270 /
        // ADR-0035) — the caller states participation per plugin, because the `*` prefix is the
        // only thing that carries it and there is no plugins.txt on this path to read it from.
        // Implicit masters and #434's Creation Club catalog are both forced on: neither has a line
        // to be disabled by. Both are also always resolved from the game directory itself, never a
        // mod, so their origin is always the reserved Data-directory value regardless of what the
        // caller supplied.
        var ordered = implicitKeys.Concat(creationClubNames)
            .Select(name => new ResolvedPlugin(name, Path.Combine(gameDirectory, name), IsImmutable: true, Participates: true, Origin: PluginOrigin.DataDirectory))
            .Concat(plugins
                .Where(p => !forcedNames.Contains(p.Name))
                .Select(p => new ResolvedPlugin(p.Name, p.Path, IsImmutable: false, Participates: p.Participates, Origin: p.Origin)))
            .ToList();

        return new GameSession(gameDirectory, gameRelease, ordered, logger);
    }

    private static HashSet<string> ResolveImplicitKeys(string folder, GameRelease gameRelease) =>
        Implicits.Get(gameRelease).Listings
            .Select(k => k.FileName.ToString())
            .Where(name => File.Exists(Path.Combine(folder, name)))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// #434: names cataloged in the game's own <c>[Category].ccc</c> — Creation Club content the
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

    private static List<ResolvedPlugin> ResolveFromDataFolder(
        string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease)
    {
        var implicitKeys = ResolveImplicitKeys(dataFolderPath, gameRelease);
        var creationClubNames = ResolveCreationClubNames(dataFolderPath, gameRelease);
        // #434: see LoadExplicit's identical forcedNames — a plugins.txt line for a CC-cataloged
        // plugin (the repro's three already-*-listed ESLs) loads once, from the forced block.
        var forcedNames = new HashSet<string>(implicitKeys, StringComparer.OrdinalIgnoreCase);
        forcedNames.UnionWith(creationClubNames);

        // #267 / ADR-0035: every non-comment, non-blank plugins.txt entry is indexed — enabled and
        // disabled alike. The `*` prefix (Enabled) becomes Participates, not a filter on presence.
        var explicitListings = PluginListings.RawLoadOrderListingsFromPath(pluginsTxtPath, gameRelease)
            .Where(l => !forcedNames.Contains(l.FileName));

        // Every plugin here is physically inside dataFolderPath — there is no MO2 VFS in this
        // constructor path, so every plugin's origin is the reserved Data-directory value (#269 / ADR-0036).
        return
        [
            .. implicitKeys.Concat(creationClubNames)
                        .Select(name => new ResolvedPlugin(name, Path.Combine(dataFolderPath, name), IsImmutable: true, Participates: true, Origin: PluginOrigin.DataDirectory)),
            .. explicitListings
                    .Select(l => new ResolvedPlugin(l.FileName, Path.Combine(dataFolderPath, l.FileName), IsImmutable: false, Participates: l.Enabled, Origin: PluginOrigin.DataDirectory)),
        ];
    }

    private GameSession(string dataFolderPath, GameRelease gameRelease, IReadOnlyList<ResolvedPlugin> ordered, ILogger? logger)
    {
        _logger = logger ?? NullLogger.Instance;
        _ordered = ordered;
        DataFolderPath = dataFolderPath;
        GameRelease = gameRelease;

        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Load order: {Count} plugin(s) ({Implicit} immutable)",
                ordered.Count, ordered.Count(p => p.IsImmutable));
        }
    }

    /// <summary>
    /// Opens the resolved load order one plugin at a time, yielding each as it becomes usable
    /// (#274 / ADR-0035). Lazy on purpose: the caller indexes each plugin as it lands, so a plugin's
    /// records become queryable while later plugins are still being opened, and a plugin that fails
    /// to open is recorded in <see cref="LoadFailures"/> at that moment rather than at the end.
    ///
    /// Opening is not free — <see cref="BuildPluginMetadata"/> counts the plugin's records — which is
    /// why this is interleaved with indexing rather than run to completion first.
    ///
    /// The construction/opening split is also what makes a load interruptible: abandoning the
    /// enumeration stops the load, and nothing after the last yielded plugin is ever opened.
    /// </summary>
    public IEnumerable<PluginMetadata> OpenAll()
    {
        for (int i = 0; i < _ordered.Count; i++)
        {
            var (fileName, filePath, isImmutable, participates, origin) = _ordered[i];
            if (!File.Exists(filePath))
            {
                _logger.LogWarning("Plugin file not found, skipping: {FilePath}", filePath);
                continue;
            }

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("[{Index}] Opening binary overlay: {FileName} (immutable={Immutable}, participates={Participates})",
                    i, fileName, isImmutable, participates);
            }

            var modKey = ModKey.FromFileName(fileName);
            var modPath = new ModPath(modKey, filePath);

            // A single plugin that cannot be opened or parsed (e.g. an unparseable record) must not
            // abort the whole load order: skip it, record the failure, and carry on. Metadata is built
            // before the mod is registered so a parse failure leaves nothing partially loaded.
            IModDisposeGetter? mod = null;
            PluginMetadata? metadata = null;
            try
            {
                // #515: session ingest's binary path — the "binary is for untracked plugins"
                // overlay (ADR-0041's #452 amendment) — needs the same explicit strings parameters
                // Track does, or a Localized untracked plugin throws instead of opening.
                var importTimer = Stopwatch.StartNew();
                mod = ModFactory.ImportGetter(modPath, GameRelease, LocalizedStrings.ForRead(ModFolders.Of(origin, filePath), DataFolderPath));
                var importMs = importTimer.ElapsedMilliseconds;

                var metadataTimer = Stopwatch.StartNew();
                metadata = BuildPluginMetadata(mod, _ordered[i], i);
                var metadataMs = metadataTimer.ElapsedMilliseconds;

                Register(mod, origin, fileName, metadata);

                if (_logger.IsEnabled(LogLevel.Information))
                {
                    _logger.LogInformation("[{Index}] {FileName}: {RecordCount} records, masters: [{Masters}]",
                        i, fileName, metadata.RecordCount, string.Join(", ", metadata.Masters));
                }
                // #113: per-phase load timing — the binary open is lazy, so the record count in
                // BuildPluginMetadata is where most of the parse cost actually lands.
                if (_logger.IsEnabled(LogLevel.Debug))
                {
                    _logger.LogDebug("[{Index}] {FileName} opened in {ImportMs} ms + {MetadataMs} ms metadata",
                        i, fileName, importMs, metadataMs);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[{Index}] Failed to load plugin {FileName}; skipping", i, fileName);
                AddLoadFailure(new PluginLoadFailure(fileName, PluginLoadFailure.ReasonFor(ex)));
                mod?.Dispose();
            }

            // Outside the try: a yield return cannot sit inside one, and the caller's own indexing
            // failure is its to handle (SessionManager records it through RecordIndexFailure) —
            // catching it here would file it as an *open* failure, which it is not.
            if (metadata != null) yield return metadata;
        }

        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("GameSession ready: {Count} plugin(s) open", _plugins.Count);
        }
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
    /// #288 / ADR-0041: <see cref="AddPlugin"/>'s sibling for the New Plugin gesture, whose
    /// destination is a mod folder (or MO2's overwrite/) that Mod Management resolved — never the
    /// game's Data folder <see cref="AddPlugin"/> hardcodes. A created plugin is a genuine
    /// load-order member from the moment the session opens it (participates, in load order,
    /// mutable) even though <c>plugins.txt</c> itself has not been appended yet: that append is now
    /// the caller's job (the extension's Mod Management writer, or a script/agent's own per
    /// ADR-0024) — see <c>PluginEndpoints.CreatePlugin</c>'s <c>.WithDescription</c>. Nothing here
    /// reads or writes <c>plugins.txt</c>.
    /// </summary>
    public PluginMetadata AddCreatedPlugin(string filePath, string origin)
    {
        var nextIndex = _plugins.Count == 0 ? 0 : _plugins.Max(p => p.LoadOrderIndex) + 1;
        return Open(filePath, origin, nextIndex, isImmutable: false, participates: true);
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
    /// change which file a filename resolves to underneath a loaded session, which is a reload,
    /// not a visibility toggle. Returns false when no such copy is open.
    /// </summary>
    public bool RemoveUnlistedPlugin(string pluginName, string origin)
    {
        var metadata = _plugins.FirstOrDefault(p =>
            !p.InLoadOrder
            && p.Name.Equals(pluginName, StringComparison.OrdinalIgnoreCase)
            && p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase));
        if (metadata == null) return false;

        lock (_mutation)
        {
            if (_modsByKey.Remove(KeyOf(origin, metadata.Name), out var mod) && mod is IDisposable disposable)
            {
                _mods.Remove((IModDisposeGetter)mod);
                disposable.Dispose();
            }

            _plugins.Remove(metadata);
            Volatile.Write(ref _pluginsSnapshot, [.. _plugins]);
        }
        return true;
    }

    /// <summary>
    /// Points a plugin the load order names at a different physical file — the session half of
    /// #279's per-plugin re-read (ADR-0035 § Live mutation). A mod-level change can make a plugin
    /// name resolve to a copy from a different mod; the caller (Mod Management, through
    /// <c>SessionManager.RereadPlugin</c>) supplies the new path and the origin it resolved it
    /// from, since nothing here can map a filename to a mod folder.
    /// <para>
    /// The mirror image of <see cref="RemoveUnlistedPlugin"/>'s refusal to drop a load-order
    /// member. That refusal stands, and for the reason stated there — it would change which file a
    /// filename resolves to underneath a loaded session. This does exactly that, but only at the user's
    /// explicit request and after they have been told what it costs.
    /// </para>
    /// <para>
    /// Load-order slot, participation, immutability and load-order membership all survive: none of
    /// them is a property of *which copy* provides the file, and re-deriving them here would let a
    /// re-read silently reorder the session. Only the path, the origin, and what is read out of the
    /// file itself (masters, record count) change.
    /// </para>
    /// </summary>
    public PluginMetadata RebindPlugin(PluginMetadata previous, string newPath, string newOrigin)
    {
        var fileName = previous.Name;
        var modKey = ModKey.FromFileName(fileName);

        // Opened before anything is torn down, so a file that cannot be opened or parsed leaves the
        // session exactly as it was — still serving the copy it loaded, rather than holding neither.
        // That is the whole reason the open is not folded into the swap below.
        var mod = ModFactory.ImportGetter(new ModPath(modKey, newPath), GameRelease, LocalizedStrings.ForRead(ModFolders.Of(newOrigin, newPath), DataFolderPath));
        var metadata = BuildPluginMetadata(
            mod,
            new ResolvedPlugin(fileName, newPath, previous.IsImmutable, previous.Participates, newOrigin),
            previous.LoadOrderIndex,
            previous.InLoadOrder);

        lock (_mutation)
        {
            var index = _plugins.FindIndex(p =>
                p.InLoadOrder == previous.InLoadOrder
                && p.Name.Equals(fileName, StringComparison.OrdinalIgnoreCase)
                && p.Origin.Equals(previous.Origin, StringComparison.OrdinalIgnoreCase));
            if (index < 0)
            {
                // Never append as a fallback: two PluginMetadata under one (origin, filename) makes
                // every ColumnKey-keyed lookup ambiguous — see AddUnlistedPlugin's own note.
                // Disposing what we just opened keeps a refused rebind from leaking a getter.
                mod.Dispose();
                throw new KeyNotFoundException($"No plugin '{fileName}' from origin '{previous.Origin}' is loaded.");
            }

            if (_modsByKey.Remove(KeyOf(previous.Origin, fileName), out var stale) && stale is IModDisposeGetter disposable)
            {
                _mods.Remove(disposable);
                disposable.Dispose();
            }

            _mods.Add(mod);
            _modsByKey[KeyOf(newOrigin, fileName)] = mod;
            _plugins[index] = metadata;
            Volatile.Write(ref _pluginsSnapshot, [.. _plugins]);
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Rebound {FileName}: {OldOrigin} → {NewOrigin} ({Path})",
                fileName, previous.Origin, newOrigin, newPath);
        }
        return metadata;
    }

    /// <summary>
    /// Flips a load-order member's participation flag in place — the session half of #97's live
    /// mutation (ADR-0035 § Live mutation). Mirrors <see cref="RebindPlugin"/>'s shape: the caller
    /// (<c>SessionManager.SetPluginParticipation</c>) already resolved which <see cref="PluginMetadata"/>
    /// this is via <c>RequirePlugin</c>, and this method's only job is to publish the flip through
    /// the same copy-on-write snapshot every other mutator in this class uses. Nothing here opens or
    /// re-reads the plugin file — participation is a fact about whether a load-order member competes
    /// for winner, not about what its content is.
    /// </summary>
    public PluginMetadata SetParticipation(PluginMetadata previous, bool participates)
    {
        var metadata = previous with { Participates = participates };

        lock (_mutation)
        {
            var index = _plugins.FindIndex(p =>
                p.InLoadOrder == previous.InLoadOrder
                && p.Name.Equals(previous.Name, StringComparison.OrdinalIgnoreCase)
                && p.Origin.Equals(previous.Origin, StringComparison.OrdinalIgnoreCase));
            if (index < 0)
                throw new KeyNotFoundException($"No plugin '{previous.Name}' from origin '{previous.Origin}' is loaded.");

            _plugins[index] = metadata;
            Volatile.Write(ref _pluginsSnapshot, [.. _plugins]);
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Set {FileName} participation: {Participates}", previous.Name, participates);
        }
        return metadata;
    }

    private PluginMetadata Open(
        string filePath, string origin, int loadOrderIndex, bool isImmutable, bool participates, bool inLoadOrder = true)
    {
        var fileName = Path.GetFileName(filePath);
        var modKey = ModKey.FromFileName(fileName);
        var modPath = new ModPath(modKey, filePath);
        var mod = ModFactory.ImportGetter(modPath, GameRelease, LocalizedStrings.ForRead(ModFolders.Of(origin, filePath), DataFolderPath));

        // No Mutagen LoadOrder or link cache is built here or anywhere else in this class: reads
        // answer from the DuckDB index (ADR-0005), and the write path builds its own typed cache
        // per save from the load-order members only (SessionManager.BuildTypedLinkCache). That
        // matters for this method in particular — Mutagen's LoadOrder is keyed by ModKey and
        // refuses a second listing for a filename it already holds.
        var metadata = BuildPluginMetadata(
            mod, new ResolvedPlugin(fileName, filePath, isImmutable, participates, origin), loadOrderIndex, inLoadOrder);
        Register(mod, origin, fileName, metadata);
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
            IsLight: PluginFlagPredicates.IsLight(mod, fileName),
            IsMaster: PluginFlagPredicates.IsMaster(mod, fileName),
            Masters: masters,
            RecordCount: mod.EnumerateMajorRecords().Count(),
            IsImmutable: isImmutable,
            Origin: origin,
            Participates: participates,
            InLoadOrder: inLoadOrder
        );
    }

    /// <summary>
    /// Idempotent since #274: a cancelled or failed load tears the session down where it detects the
    /// problem, and the load's own catch disposes it too, so both paths can reach here for one
    /// session. Disposing a Mutagen overlay twice is not benign.
    /// </summary>
    public void Dispose()
    {
        lock (_mutation)
        {
            foreach (var mod in _mods)
            {
                // Stryker disable once Statement : verifying per-mod disposal requires OS-level resource checks beyond the public API
                mod.Dispose();
            }
            _mods.Clear();
            _modsByKey.Clear();
        }
    }
}
