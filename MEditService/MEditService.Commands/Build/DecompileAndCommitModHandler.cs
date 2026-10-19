using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Build;

/// <summary>The init gesture's handler (ADR-0007, ADR-0014). The mod is the item of the selection:
/// it lands whole with one commit, `Init &lt;mod&gt;`, or refuses whole.</summary>
public sealed class DecompileAndCommitModHandler
{
    private readonly LoadOrderHolder _loadOrder;
    private readonly ILogger _logger;
    private readonly INotificationPublisher _notifications;
    private readonly ISourceAdapter _source;
    private readonly IModFolderRepository _modFolders;
    private readonly IPluginAdapter _plugins;
    private readonly PluginDecompiler _decompiler;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal DecompileAndCommitModHandler(
        LoadOrderHolder loadOrder, IPluginAdapter adapter, ISourceAdapter source, IModFolderRepository modFolders,
        INotificationPublisher notifications, ILogger<DecompileAndCommitModHandler> logger) =>
        (_loadOrder, _source, _modFolders, _plugins, _notifications, _logger, _decompiler) =
            (loadOrder, source, modFolders, adapter, notifications, logger, new PluginDecompiler(logger, adapter, source));

    /// <summary>Each mod's plugins and folder are the held load order's. Refuses with
    /// <see cref="DecompileAndCommitRefusal.NoLoadOrder"/>, writing nothing, when none is held; git missing refuses
    /// the whole selection once.</summary>
    public async Task<Answer<DecompileAndCommitResult, SelectionRefusal<DecompileAndCommitRefusal>>> DecompileAndCommitAsync(
        IReadOnlyList<ModToDecompileAndCommit> mods, CancellationToken cancel = default)
    {
        if (_loadOrder.Held is not { Snapshot: var loadOrder })
            return new SelectionRefusal<DecompileAndCommitRefusal>(DecompileAndCommitRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);
        if (_source.WhyGitCannotRun() is { } gitMissing)
            return new SelectionRefusal<DecompileAndCommitRefusal>(DecompileAndCommitRefusal.GitUnavailable, gitMissing.Reason);
        var decompiled = await ModByMod.OverAsync(
            mods, mod => mod.Name, progress => _notifications.Publish(new DecompileAndCommitProgressNotification(progress, Phase: null)),
            (mod, at) => InitModAsync(loadOrder, mod, ProvidedBy(loadOrder, mod.Name), at, cancel), gesture: null, cancel);
        return decompiled.ToAnswer(
            landed => new DecompiledAndCommittedMod(landed.Item, landed.Outcome),
            refused => new DecompileAndCommitRefused(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new DecompileAndCommitResult(applied, refused));
    }

    private static List<RegisteredPlugin> ProvidedBy(LoadOrderSnapshot loadOrder, string modName) =>
        [.. loadOrder.Plugins.Where(plugin => plugin.Provider is PluginProvider.FromMod mod
            && string.Equals(mod.Name, modName, StringComparison.OrdinalIgnoreCase))];

    private async Task<ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>> InitModAsync(
        LoadOrderSnapshot loadOrder, ModToDecompileAndCommit toInit, List<RegisteredPlugin> plugins, ModlistProgress at, CancellationToken cancel)
    {
        if (plugins.Count == 0)
        {
            return ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>.Refused(DecompileAndCommitRefusal.ModProvidesNoPlugin,
                $"'{toInit.Name}' provides no plugin in the load order, so there is nothing to decompile and commit.");
        }

        var mod = (PluginProvider.FromMod)plugins[0].Provider;

        if (_source.IsSourceMod(toInit.SourceFolder))
        {
            return ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>.Refused(DecompileAndCommitRefusal.AlreadyInitialized,
                $"'{toInit.SourceFolder}' already holds a repository. To put a plugin's source into its working tree, decompile it.");
        }

        // A .git with no main that Modbench did not make is someone else's, never written to (ADR-0003).
        if (_source.HoldsAnotherRepository(toInit.SourceFolder))
        {
            return ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>.Refused(DecompileAndCommitRefusal.AlreadyInitialized,
                $"'{toInit.SourceFolder}' already holds a repository with no main branch, made outside Modbench.");
        }

        var verified = new List<(RegisteredPlugin Plugin, PluginSource Source)>();
        var refused = new List<ItemRefused<PluginAddress, DecompileAndCommitRefusal>>();
        foreach (var plugin in plugins)
        {
            cancel.ThrowIfCancellationRequested();
            SetPhase(at, DecompileAndCommitPhase.Parsing);
            var decompiled = await _decompiler.DecompileAsync(
                loadOrder, plugin, mod.Folder, onParsed: () => SetPhase(at, DecompileAndCommitPhase.Serializing), cancel);
            if (decompiled.Source is { } source)
            {
                verified.Add((plugin, source));
            }
            else
            {
                refused.Add(new ItemRefused<PluginAddress, DecompileAndCommitRefusal>(
                    plugin.Key,
                    decompiled.Refusal == DecompileRefusal.MissingLocalizationStrings
                        ? DecompileAndCommitRefusal.MissingLocalizationStrings
                        : DecompileAndCommitRefusal.RoundTripFailed,
                    decompiled.Message));
            }

        }

        if (refused.Count > 0)
        {
            var cause = refused.Select(r => r.Refusal).Distinct().ToList() is [var shared] ? shared : DecompileAndCommitRefusal.PluginsRefused;
            return ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>.Refused(cause, string.Join('\n', refused.Select(r => r.Message)));
        }

        SetPhase(at, DecompileAndCommitPhase.ReadingFiles);
        List<Asset> assets;
        try
        {
            assets = AssetsOf(mod, toInit, plugins, loadOrder.GameRelease);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>.Refused(DecompileAndCommitRefusal.ModFilesUnreadable,
                $"'{mod.Name}' was not initialized: a file of its folder could not be read: {ex.Message}");
        }

        SetPhase(at, DecompileAndCommitPhase.Committing);
        if (Commit(mod, toInit.SourceFolder, verified, assets) is { } failure)
        {
            _logger.LogWarning("Refused to init {Mod}: {Reason}", mod.Name, failure.Reason);
            return ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>.Refused(DecompileAndCommitRefusal.CommitFailed, $"'{mod.Name}' was not initialized: {failure.Reason}");
        }

        return ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>.Landed([.. plugins.Select(p => p.Key)]);
    }

    // The assets are every file of the mod but what compile writes for its plugins, a build output, and the mod
    // manager's own files (plugins.md, Decompile and commit, story 2).
    private List<Asset> AssetsOf(PluginProvider.FromMod mod, ModToDecompileAndCommit toInit, List<RegisteredPlugin> plugins, GameRelease release)
    {
        var all = _modFolders.Files(mod.Folder, mod.Name, toInit.MetadataFiles.ToHashSet(StringComparer.Ordinal), statCache: null).Files;
        var paths = all.Select(file => file.Path).ToList();
        var compiled = plugins.SelectMany(plugin => _plugins.WrittenByCompile(plugin, paths, release)).ToHashSet(StringComparer.Ordinal);
        return
        [
            .. all
                .Where(file => !compiled.Contains(file.Path))
                .Select(file => new Asset(file.Path, () => _modFolders.OpenFile(mod.Folder, file.Path))),
        ];
    }

    // The adapter writes nothing when any of it fails (plugins.md, Init, story 5).
    private SourceFailure? Commit(
        PluginProvider.FromMod mod, string sourceFolder, List<(RegisteredPlugin Plugin, PluginSource Source)> verified, List<Asset> assets)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Initializing {SourceFolder} with {PluginCount} plugin(s), {FileCount} source files and {AssetCount} asset(s)",
                sourceFolder, verified.Count, verified.Sum(v => v.Source.Files.Count), assets.Count);
        }

        return _source.Init(sourceFolder, _modFolders.FolderName(mod.Folder),
            [.. verified.Select(v => (v.Source.Files, new DecompiledPlugin(v.Plugin.Name, v.Source.BinarySha256)))], assets);
    }

    private void SetPhase(ModlistProgress at, DecompileAndCommitPhase phase) =>
        _notifications.Publish(new DecompileAndCommitProgressNotification(at, phase));
}
