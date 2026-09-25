using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands;

/// <summary>Absorb's handler: re-serializes each changed plugin as Track does, and commits each
/// one's new baseline to main and then the mod's tracked-file change. The edit branch does not
/// move (ADR-0003 invariant 3).</summary>
public sealed class AbsorbExternalChangeHandler
{
    private readonly IPluginAdapter _adapter;
    private readonly LoadOrderHolder _loadOrder;
    private readonly ILogger<AbsorbExternalChangeHandler> _logger;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal AbsorbExternalChangeHandler(
        IPluginAdapter adapter, LoadOrderHolder loadOrder, ILogger<AbsorbExternalChangeHandler> logger) =>
        (_adapter, _loadOrder, _logger) = (adapter, loadOrder, logger);

    /// <summary>Origin-scoped: the mod, not one plugin in it, is the unit of a baseline. Null when
    /// the origin names no tracked mod in the load order, which is an addressing failure rather
    /// than a refusal.</summary>
    public async Task<AbsorbResult?> AbsorbAsync(string origin)
    {
        var loadOrder = _loadOrder.Current;
        if (TrackedOrigin.Resolve(loadOrder, origin) is not { } mod) return null;

        var result = await Run(_adapter, origin, mod.ModFolder, mod.Plugins, loadOrder);
        // Track's own endpoint already logs its refusal, so Absorb gains the same posture.
        if (result.AnswerRefusal is { } whole)
            _logger.LogWarning("Refused to absorb {ModFolder}: {Refusal} — {Message}", mod.ModFolder, whole.Refusal, whole.Message);
        foreach (var refused in result.Refused)
        {
            _logger.LogWarning("Refused to absorb {Plugin} ({Origin}): {Refusal} — {Message}",
                refused.Plugin.Name, refused.Plugin.Origin, refused.Refusal, refused.Message);
        }
        if (result.TrackedFilesRefusal is { } trackedFiles)
            _logger.LogWarning("Refused to absorb {ModFolder}'s tracked files: {Message}", mod.ModFolder, trackedFiles);

        // Only a whole answer ends the question: the next classification finds exactly what did not
        // land, and asks again.
        if (result.AllApplied) EndQuestion(mod.ModFolder);
        return result;
    }

    // Every write classifies again while the marker stands (WriteTargets.BlockingQuestion), so a
    // marker left behind here ends at the next write rather than blocking the mod.
    private void EndQuestion(string modFolder)
    {
        try
        {
            SourceRepository.ClearExternalChangeQuestion(modFolder);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Absorbed {ModFolder}, but its question marker could not be removed", modFolder);
        }
    }

    // Static because none of it reads this handler's state beyond the port it is handed.
    private static async Task<AbsorbResult> Run(
        IPluginAdapter adapter, string origin, string modFolder, IReadOnlyList<RegisteredCopy> plugins, LoadOrderSnapshot loadOrder)
    {
        var observed = new List<(string PluginName, byte[] ObservedBytes)>();
        foreach (var copy in ExternalChangeClassifier.CopiesIn(loadOrder, modFolder))
        {
            try
            {
                observed.Add((copy.Name, await PluginBinaryHash.ExactBytesOfFileAsync(copy.Path)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return AbsorbResult.WholeAnswerRefused(
                    TrackRefusal.RoundTripFailed, $"{copy.Name} ({copy.Origin}) could not be read: {ex.Message}");
            }
        }

        // The classifier's own rule, recomputed from git: a plugin whose baseline landed on an earlier
        // answer matches its parked ref, so answering again commits only what is left.
        var changed = ExternalChangeClassifier.ChangedPlugins(modFolder, observed).ToHashSet(StringComparer.OrdinalIgnoreCase);

        var meta = SourceRepository.MetaFactsIn(modFolder);
        var baselines = new List<(IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers)>();

        foreach (var plugin in plugins.Where(p => changed.Contains(p.Name)))
        {
            // A fresh deep parse of the binary now on disk, never a cached load-order view — that stale
            // view is what this method reacts to. Absorb only runs against a tracked plugin, so the
            // mod-folder-only strings overload applies.
            try
            {
                var tree = await adapter.ReadPristineFilesAsync(
                    new ModPath(ModKey.FromFileName(plugin.Name), plugin.Path),
                    loadOrder.GameRelease, PluginStrings.In(modFolder));
                baselines.Add((
                    SourceRepository.PristineFilesOf(plugin.Name, tree),
                    new BaselineTrailers(
                        plugin.Name, meta.UpstreamVersion, meta.MetaSha256, PluginBinaryHash.TrailerFormOfFile(plugin.Path))));
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                // A raw parse exception's Message carries no located identity; the diagnosis walks the
                // tree for the innermost RecordException, as Track's own parse refusal does.
                return AbsorbResult.WholeAnswerRefused(TrackRefusal.RoundTripFailed,
                    $"{plugin.Name} could not be parsed from its own binary: {PluginDiagnosis.FromParseException(ex).Describe()}");
            }
        }

        var trackedFileChanges = SourceRepository.ChangedTrackedFilesOutsideSource(modFolder);
        var trailers = baselines.Select(b => b.Trailers).ToList();

        try
        {
            if (SourceRepository.CommitBaselinesToMain(modFolder, baselines) is { } stopped)
                return StoppedAt(origin, trailers, stopped, trackedFilesWaiting: trackedFileChanges.Count > 0);
        }
        catch (GitUnavailableException ex)
        {
            return AbsorbResult.WholeAnswerRefused(TrackRefusal.GitUnavailable, ex.Message);
        }

        IReadOnlyList<PluginCopyKey> landed = [.. trailers.Select(b => Addressed(origin, b))];
        if (SourceRepository.CommitTrackedFilesToMain(modFolder, trackedFileChanges) is { } failed)
            return AbsorbResult.PerPlugin(landed, [], $"'{failed.Subject}' {failed.Reason}.");

        // Index matches the working tree for every changed tracked file, so the same bytes cannot
        // re-raise the question next load.
        try
        {
            SourceRepository.StageTrackedFileChanges(modFolder, trackedFileChanges);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return AbsorbResult.PerPlugin(landed, [],
                $"The changed tracked files landed on main, but could not be staged on the edit branch: {ex.Message.Trim()}");
        }
        return AbsorbResult.PerPlugin(landed, [], trackedFilesRefusal: null);
    }

    // The baselines before the stopped one landed; it and every one after it did not, and neither did
    // the tracked files, which come last.
    private static AbsorbResult StoppedAt(
        string origin, List<BaselineTrailers> baselines, (BaselineTrailers Baseline, string Subject, string Reason) stopped,
        bool trackedFilesWaiting)
    {
        var at = baselines.IndexOf(stopped.Baseline);
        var refused = new List<TrackRefused>
        {
            new(Addressed(origin, stopped.Baseline), TrackRefusal.CommitFailed,
                $"'{stopped.Subject}' {stopped.Reason}. Nothing after it was committed."),
        };
        refused.AddRange(baselines.Skip(at + 1).Select(b => new TrackRefused(
            Addressed(origin, b), TrackRefusal.StoppedByEarlierFailure,
            $"{b.Plugin} was not committed: '{stopped.Subject}' failed first and stopped the run. Answering again commits it.")));
        var trackedFilesRefusal = trackedFilesWaiting
            ? $"The changed tracked files were not committed: '{stopped.Subject}' failed first and stopped the run. Answering again commits them."
            : null;
        return AbsorbResult.PerPlugin([.. baselines.Take(at).Select(b => Addressed(origin, b))], refused, trackedFilesRefusal);
    }

    private static PluginCopyKey Addressed(string origin, BaselineTrailers baseline) => new(baseline.Plugin, origin);
}
