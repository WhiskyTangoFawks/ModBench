using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Build;

/// <summary>The init gesture's handler (ADR-0007, ADR-0014). The mod is the item of the selection:
/// it lands whole with one commit, `Init &lt;mod&gt;`, or refuses whole.</summary>
public sealed class InitModHandler
{
    private readonly LoadOrderHolder _loadOrder;
    private readonly ILogger _logger;
    private readonly INotificationPublisher _notifications;
    private readonly ISourceAdapter _source;
    private readonly IModFolderRepository _modFolders;
    private readonly IPluginAdapter _plugins;
    private readonly PluginDecompiler _decompiler;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal InitModHandler(
        LoadOrderHolder loadOrder, IPluginAdapter adapter, ISourceAdapter source, IModFolderRepository modFolders,
        INotificationPublisher notifications, ILogger<InitModHandler> logger) =>
        (_loadOrder, _source, _modFolders, _plugins, _notifications, _logger, _decompiler) =
            (loadOrder, source, modFolders, adapter, notifications, logger, new PluginDecompiler(logger, adapter, source));

    /// <summary>Each mod's plugins and folder are the held load order's. Refuses with
    /// <see cref="InitRefusal.NoLoadOrder"/>, writing nothing, when none is held; git missing refuses
    /// the whole selection once.</summary>
    public async Task<SelectionResult<string, InitRefusal, InitializedMod>> InitAsync(
        IReadOnlyList<ModToInit> mods, CancellationToken cancel = default)
    {
        if (_loadOrder.Held is not { Snapshot: var loadOrder })
            return SelectionResult<string, InitRefusal, InitializedMod>.WholeSelectionRefused(InitRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);
        if (_source.WhyGitCannotRun() is { } gitMissing)
            return SelectionResult<string, InitRefusal, InitializedMod>.WholeSelectionRefused(InitRefusal.GitUnavailable, gitMissing.Reason);
        var byName = mods.DistinctBy(mod => mod.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(mod => mod.Name, StringComparer.OrdinalIgnoreCase);
        var done = 0;
        return await ModByMod.OverAsync(
            mods, mod => mod.Name, progress => _notifications.Publish(new DecompileAndCommitProgressNotification(progress)),
            async mod =>
            {
                try
                {
                    return await InitModAsync(loadOrder, byName[mod.Name], ProvidedBy(loadOrder, mod.Name), done, byName.Count, cancel);
                }
                finally
                {
                    done++;
                }
            }, gesture: null, cancel);
    }

    private static List<RegisteredPlugin> ProvidedBy(LoadOrderSnapshot loadOrder, string modName) =>
        [.. loadOrder.Plugins.Where(plugin => plugin.Provider is PluginProvider.FromMod mod
            && string.Equals(mod.Name, modName, StringComparison.OrdinalIgnoreCase))];

    private async Task<ItemAnswer<InitRefusal, InitializedMod>> InitModAsync(
        LoadOrderSnapshot loadOrder, ModToInit toInit, List<RegisteredPlugin> plugins, int modsDone, int modsTotal, CancellationToken cancel)
    {
        if (plugins.Count == 0)
        {
            return ItemAnswer<InitRefusal, InitializedMod>.Refused(InitRefusal.ModProvidesNoPlugin,
                $"'{toInit.Name}' provides no plugin in the load order, so there is nothing to decompile and commit.");
        }

        var mod = (PluginProvider.FromMod)plugins[0].Provider;

        if (_source.IsSourceMod(toInit.SourceFolder))
        {
            return ItemAnswer<InitRefusal, InitializedMod>.Refused(InitRefusal.AlreadyInitialized,
                $"'{toInit.SourceFolder}' already holds a repository. To put a plugin's source into its working tree, decompile it.");
        }

        // A .git with no main that Modbench did not make is someone else's, never written to (ADR-0003).
        if (_source.HoldsAnotherRepository(toInit.SourceFolder))
        {
            return ItemAnswer<InitRefusal, InitializedMod>.Refused(InitRefusal.AlreadyInitialized,
                $"'{toInit.SourceFolder}' already holds a repository with no main branch, made outside Modbench.");
        }

        var verified = new List<(RegisteredPlugin Plugin, PluginSource Source)>();
        var refused = new List<ItemRefused<PluginAddress, InitRefusal>>();
        foreach (var plugin in plugins)
        {
            cancel.ThrowIfCancellationRequested();
            SetPhase(mod.Name, DecompileAndCommitPhase.Parsing, modsDone, modsTotal);
            var decompiled = await _decompiler.DecompileAsync(
                loadOrder, plugin, mod.Folder, onParsed: () => SetPhase(mod.Name, DecompileAndCommitPhase.Serializing, modsDone, modsTotal), cancel);
            if (decompiled.Source is { } source)
            {
                verified.Add((plugin, source));
            }
            else
            {
                refused.Add(new ItemRefused<PluginAddress, InitRefusal>(
                    plugin.Key,
                    decompiled.Refusal == DecompileRefusal.MissingLocalizationStrings
                        ? InitRefusal.MissingLocalizationStrings
                        : InitRefusal.RoundTripFailed,
                    decompiled.Message));
            }

        }

        if (refused.Count > 0)
        {
            var cause = refused.Select(r => r.Refusal).Distinct().ToList() is [var shared] ? shared : InitRefusal.PluginsRefused;
            return ItemAnswer<InitRefusal, InitializedMod>.Refused(cause, string.Join('\n', refused.Select(r => r.Message)));
        }

        SetPhase(mod.Name, DecompileAndCommitPhase.ReadingFiles, modsDone, modsTotal);
        List<Asset> assets;
        try
        {
            assets = AssetsOf(mod, toInit, plugins, loadOrder.GameRelease);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<InitRefusal, InitializedMod>.Refused(InitRefusal.ModFilesUnreadable,
                $"'{mod.Name}' was not initialized: a file of its folder could not be read: {ex.Message}");
        }

        SetPhase(mod.Name, DecompileAndCommitPhase.Committing, modsDone, modsTotal);
        if (Commit(mod, toInit.SourceFolder, verified, assets) is { } failure)
        {
            _logger.LogWarning("Refused to init {Mod}: {Reason}", mod.Name, failure.Reason);
            return ItemAnswer<InitRefusal, InitializedMod>.Refused(InitRefusal.CommitFailed, $"'{mod.Name}' was not initialized: {failure.Reason}");
        }

        return ItemAnswer<InitRefusal, InitializedMod>.Landed(new InitializedMod([.. plugins.Select(p => p.Key)]));
    }

    // The assets are every file of the mod but what compile writes for its plugins, a build output, and the mod
    // manager's own files (plugins.md, Decompile and commit, story 2).
    private List<Asset> AssetsOf(PluginProvider.FromMod mod, ModToInit toInit, List<RegisteredPlugin> plugins, GameRelease release)
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

    private void SetPhase(string mod, DecompileAndCommitPhase phase, int modsDone, int modsTotal) =>
        _notifications.Publish(new DecompileAndCommitProgressNotification(new ModlistProgress(Gesture: null, mod, modsDone, modsTotal, phase)));
}
