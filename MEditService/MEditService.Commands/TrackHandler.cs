using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// it lands whole with one commit, `Track &lt;mod&gt;`, or refuses whole.</summary>
/// it lands with one commit, `Track &lt;mod&gt;`, holding the source of every plugin of the mod, or no commit when any plugin is refused.</summary>
public sealed class TrackHandler
{
    private readonly LoadOrderHolder _loadOrder;
    private readonly ILogger _logger;
    private readonly INotificationPublisher _notifications;
    private readonly PluginDecompiler _decompiler;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal TrackHandler(
        LoadOrderHolder loadOrder, IPluginAdapter adapter, INotificationPublisher notifications, ILogger<TrackHandler> logger) =>
        (_loadOrder, _notifications, _logger, _decompiler) = (loadOrder, notifications, logger, new PluginDecompiler(logger, adapter));

    /// <summary>Each name is a mod, whose plugins and folder the held load order says. Throws
    /// <see cref="NoLoadOrderException"/> with nothing written when none is held; git missing refuses
    /// the whole selection once.</summary>
    public async Task<SelectionResult<string, TrackRefusal, TrackedMod>> TrackAsync(
        IReadOnlyList<string> mods, CancellationToken cancel = default)
    {
        var loadOrder = _loadOrder.Require();
        var total = mods.Distinct(StringComparer.OrdinalIgnoreCase).Sum(mod => ProvidedBy(loadOrder, mod).Count);
        var done = 0;
        try
        {
            return await ItemWrite.OverAsync(mods, StringComparer.OrdinalIgnoreCase, TrackRefusal.GitUnavailable, async mod =>
            {
                var plugins = ProvidedBy(loadOrder, mod);
                var answer = await TrackModAsync(loadOrder, mod, plugins, done, total, cancel);
                done += plugins.Count;
                return answer;
            });
        }
        finally
        {
            // Idle at rest, success or failure alike: a client must never keep showing a track that has finished.
            SetProgress(null, TrackPhase.Idle, 0, 0);
        }
    }

    private static List<RegisteredPlugin> ProvidedBy(LoadOrderSnapshot loadOrder, string modName) =>
        [.. loadOrder.Plugins.Where(plugin => plugin.Provider is PluginProvider.FromMod mod
            && string.Equals(mod.Name, modName, StringComparison.OrdinalIgnoreCase))];

    private async Task<ItemAnswer<TrackRefusal, TrackedMod>> TrackModAsync(
        LoadOrderSnapshot loadOrder, string modName, List<RegisteredPlugin> plugins, int done, int total, CancellationToken cancel)
    {
        if (plugins.Count == 0)
        {
            return ItemAnswer<TrackRefusal, TrackedMod>.Refused(TrackRefusal.ModProvidesNoPlugin,
                $"'{modName}' provides no plugin in the load order, so there is nothing to track.");
        }

        var modFolder = ((PluginProvider.FromMod)plugins[0].Provider).Folder;

        // Track takes a mod with no repository (ADR-0007).
        if (SourceRepository.IsTracked(modFolder))
        {
            return ItemAnswer<TrackRefusal, TrackedMod>.Refused(TrackRefusal.AlreadyTracked,
                $"'{modFolder}' is already tracked. To put a plugin's source into its working tree, decompile it.");
        }

        // A .git with no main that Track did not mark is someone else's, never written to (ADR-0003).
        if (SourceRepository.HoldsAnotherRepository(modFolder))
        {
            return ItemAnswer<TrackRefusal, TrackedMod>.Refused(TrackRefusal.AlreadyTracked,
                $"'{modFolder}' already holds a repository Track did not make, with no main branch.");
        }

        var verified = new List<(RegisteredPlugin Plugin, IReadOnlyList<TreeFile> Files)>();
        var refused = new List<ItemRefused<PluginAddress, TrackRefusal>>();
        foreach (var plugin in plugins)
        {
            cancel.ThrowIfCancellationRequested();
            SetProgress(modName, TrackPhase.Parsing, done, total);
            var decompiled = await _decompiler.DecompileAsync(
                loadOrder, plugin, modFolder, onParsed: () => SetProgress(modName, TrackPhase.Serializing, done, total), cancel);
            if (decompiled.Files is { } files)
            {
                verified.Add((plugin, files));
            }
            else
            {
                refused.Add(new ItemRefused<PluginAddress, TrackRefusal>(
                    plugin.Key,
                    decompiled.Refusal == DecompileRefusal.MissingLocalizationStrings
                        ? TrackRefusal.MissingLocalizationStrings
                        : TrackRefusal.RoundTripFailed,
                    decompiled.Message));
            }

            done++;
            SetProgress(modName, TrackPhase.Serializing, done, total);
        }

        if (refused.Count == 0)
        {
            SetProgress(modName, TrackPhase.Committing, total, total);
            refused = Commit(modFolder, verified);
        }

        if (refused.Count == 0) return ItemAnswer<TrackRefusal, TrackedMod>.Landed(new TrackedMod([.. plugins.Select(p => p.Key)], []));

        var cause = refused.Select(r => r.Refusal).Distinct().ToList() is [var shared] ? shared : TrackRefusal.NoPluginTracked;
        return ItemAnswer<TrackRefusal, TrackedMod>.Refused(cause, string.Join('\n', refused.Select(r => r.Message)));
    }

    // One commit holding every plugin; the adapter writes nothing when any plugin's files fail (plugins.md, Track, story 5).
    private List<ItemRefused<PluginAddress, TrackRefusal>> Commit(
        string modFolder, List<(RegisteredPlugin Plugin, IReadOnlyList<TreeFile> Files)> verified)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Tracking {PluginCount} plugin(s) into {ModFolder}: {FileCount} source files",
                verified.Count, modFolder, verified.Sum(v => v.Files.Count));
        }

        IReadOnlyList<(string Plugin, string Reason)> failed;
        try
        {
            failed = SourceRepository.Track(modFolder,
                [.. verified.Select(v => (v.Files, new DecompiledPlugin(v.Plugin.Name, PluginBinaryHash.TrailerFormOfFile(v.Plugin.Path))))]);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            _logger.LogError(ex, "Could not finish tracking into {ModFolder}", modFolder);
            failed = [.. verified.Select(v => (v.Plugin.Name, ex.Message))];
        }

        var refused = new List<ItemRefused<PluginAddress, TrackRefusal>>();
        foreach (var plugin in verified.Select(v => v.Plugin))
        {
            if (failed.FirstOrDefault(f => string.Equals(f.Plugin, plugin.Name, StringComparison.OrdinalIgnoreCase)) is { Reason: { } reason })
            {
                _logger.LogWarning("Refused to track {Plugin} ({Origin}): its source could not be tracked — {Reason}", plugin.Name, plugin.Origin, reason);
                refused.Add(new ItemRefused<PluginAddress, TrackRefusal>(
                    plugin.Key, TrackRefusal.CommitFailed, $"{plugin.Name}'s source could not be tracked: {reason}"));
            }
        }

        return refused;
    }

    private void SetProgress(string? mod, TrackPhase phase, int pluginsDone, int pluginsTotal) =>
        _notifications.Publish(new TrackProgressNotification(new TrackProgress(mod, phase, pluginsDone, pluginsTotal)));
}
