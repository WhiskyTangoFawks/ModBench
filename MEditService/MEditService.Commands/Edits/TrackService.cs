using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>The Track gesture end to end (ADR-0007).</summary>
public sealed class TrackService(
    ILogger<TrackService> logger, IPluginAdapter adapter, INotificationPublisher? notifications = null)
{
    // Read concurrently while a track is in flight. Snapshots are replaced wholesale, never
    // mutated, so Volatile.Read/Write suffices and no lock is needed.
    private TrackProgress _progress = TrackProgress.Idle;
    public TrackProgress Progress => Volatile.Read(ref _progress);
    // Null in every test that does not care, and nothing is published when it is.
    private readonly INotificationPublisher? _notifications = notifications;
    private readonly PluginDecompiler _decompiler = new(logger, adapter);

    /// <summary>Per plugin (commands.md, A selection is one gesture).</summary>
    public async Task<TrackSelectionResult> TrackAsync(
        LoadOrderSnapshot loadOrder,
        IReadOnlyList<PluginAddress> plugins,
        SourcePreset preset,
        IReadOnlyDictionary<string, string> upstreamVersionByOrigin,
        CancellationToken cancel = default)
    {
        try
        {
            SourceRepository.EnsureTrackable();
        }
        catch (GitUnavailableException ex)
        {
            return TrackSelectionResult.WholeSelectionRefused(TrackRefusal.GitUnavailable, ex.Message);
        }

        var selection = plugins.Distinct(PluginAddress.Comparer).ToList();
        var refused = new List<TrackRefused>();
        var verified = new List<VerifiedPlugin>();
        try
        {
            for (var done = 0; done < selection.Count; done++)
            {
                cancel.ThrowIfCancellationRequested();
                var plugin = selection[done];
                SetProgress(plugin.Origin, TrackPhase.Parsing, done, selection.Count);
                var outcome = await VerifyAsync(
                    loadOrder, plugin, upstreamVersionByOrigin.GetValueOrDefault(plugin.Origin),
                    onParsed: () => SetProgress(plugin.Origin, TrackPhase.Serializing, done, selection.Count), cancel);
                if (outcome.Verified is { } passed) verified.Add(passed);
                if (outcome.Refused is { } refusal) refused.Add(refusal);
                SetProgress(plugin.Origin, TrackPhase.Serializing, done + 1, selection.Count);
            }

            SetProgress(verified.FirstOrDefault()?.Plugin.Origin, TrackPhase.Committing, selection.Count, selection.Count);
            var landed = new List<PluginAddress>();
            foreach (var mod in verified.GroupBy(v => v.ModFolder, StringComparer.Ordinal))
                Commit(mod.Key, preset, [.. mod], landed, refused);

            return TrackSelectionResult.PerPlugin(InSelectionOrder(landed, p => p), InSelectionOrder(refused, r => r.Plugin));
        }
        finally
        {
            // Idle at rest, success or failure alike — a poller must never keep reporting a track that has
            // finished.
            SetProgress(null, TrackPhase.Idle, 0, 0);
        }

        List<T> InSelectionOrder<T>(IEnumerable<T> items, Func<T, PluginAddress> keyOf) =>
            [.. items.OrderBy(item => selection.FindIndex(p => PluginAddress.Comparer.Equals(p, keyOf(item))))];
    }

    private sealed record VerifiedPlugin(PluginAddress Plugin, string ModFolder, IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers);

    private sealed record Verification(VerifiedPlugin? Verified, TrackRefused? Refused);

    // One repository per mod folder: the plugins that passed their gate, in one commit.
    private void Commit(
        string modFolder, SourcePreset preset, IReadOnlyList<VerifiedPlugin> plugins,
        List<PluginAddress> landed, List<TrackRefused> refused)
    {
        IReadOnlyList<(IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers)> baselines = [.. plugins.Select(v => (v.Files, v.Trailers))];
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Tracking {PluginCount} plugin(s) into {ModFolder}: {FileCount} source files",
                plugins.Count, modFolder, plugins.Sum(v => v.Files.Count));
        }

        IReadOnlyList<(string Plugin, string Reason)> failed;
        try
        {
            failed = SourceRepository.Track(modFolder, preset, baselines);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            // The track's one commit failed and Track took back what it made: no plugin landed (plugins.md, Track, story 5).
            logger.LogError(ex, "Could not finish tracking into {ModFolder}", modFolder);
            failed = [.. plugins.Select(v => (v.Plugin.Name, ex.Message))];
        }

        foreach (var plugin in plugins.Select(v => v.Plugin))
        {
            if (failed.FirstOrDefault(f => string.Equals(f.Plugin, plugin.Name, StringComparison.OrdinalIgnoreCase)) is { Reason: { } reason })
            {
                logger.LogWarning("Refused to track {Plugin} ({Origin}): its source could not be tracked —{Reason}", plugin.Name, plugin.Origin, reason);
                refused.Add(new TrackRefused(
                    plugin, TrackRefusal.CommitFailed, $"{plugin.Name}'s source could not be tracked:{reason}"));
            }
            else
            {
                landed.Add(plugin);
            }
        }
    }

    // Every refusal comes before the plugin's commit (commands.md, A selection is one gesture).
    private async Task<Verification> VerifyAsync(
        LoadOrderSnapshot loadOrder, PluginAddress key, string? upstreamVersion, Action onParsed, CancellationToken cancel)
    {
        Verification Refuse(TrackRefusal refusal, string message) => new(null, new TrackRefused(key, refusal, message));

        if (loadOrder.Plugin(key) is not { } plugin)
        {
            return Refuse(TrackRefusal.PluginNotLoaded,
                $"{key.Name} from '{key.Origin}' is not in the load order, so there is nothing to track.");
        }

        if (plugin.Provider is not PluginProvider.FromMod { Folder: var modFolder })
        {
            return plugin.Provider == PluginProvider.NoMod
                ? Refuse(TrackRefusal.OverwriteOrigin,
                    $"{plugin.Name} is loaded from Overwrite, an origin and not a mod, so it has no repository " +
                    "to track into. Move it into a mod, then track that.")
                : Refuse(TrackRefusal.DataDirectoryOrigin,
                    $"{plugin.Name} is a base-game plugin loaded from the game's own Data folder, " +
                    "and the game's own plugins cannot be tracked in place. Author a patch plugin and track that instead.");
        }

        // Track takes a mod with no repository (ADR-0007).
        if (SourceRepository.IsTracked(modFolder))
        {
            return Refuse(TrackRefusal.AlreadyTracked,
                $"'{modFolder}' is already tracked. To put {plugin.Name}'s source into its working tree, decompile it.");
        }

        // A repository with history but no main is someone else's, never written to (ADR-0003).
        if (SourceRepository.HoldsAnotherRepository(modFolder))
            return Refuse(TrackRefusal.AlreadyTracked, $"'{modFolder}' already holds a repository with no main branch.");

        var decompiled = await _decompiler.DecompileAsync(loadOrder, plugin, modFolder, onParsed, cancel);
        if (decompiled.Files is not { } files)
        {
            return Refuse(decompiled.Refusal == DecompileRefusal.MissingLocalizationStrings
                ? TrackRefusal.MissingLocalizationStrings
                : TrackRefusal.RoundTripFailed, decompiled.Message);
        }

        return new Verification(
            new VerifiedPlugin(
                key, modFolder, files,
                new BaselineTrailers(key.Name, upstreamVersion, PluginBinaryHash.TrailerFormOfFile(plugin.Path))),
            null);
    }

    private void SetProgress(string? origin, TrackPhase phase, int pluginsDone, int pluginsTotal)
    {
        var progress = new TrackProgress(origin, phase, pluginsDone, pluginsTotal);
        Volatile.Write(ref _progress, progress);
        _notifications?.Publish(new TrackProgressNotification(progress));
    }
}
