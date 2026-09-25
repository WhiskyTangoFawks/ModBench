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
        if (!result.Applied)
            _logger.LogWarning("Refused to absorb {ModFolder}: {Reason}", mod.ModFolder, result.RefusalReason);
        return result;
    }

    // Static because none of it reads this handler's state beyond the port it is handed.
    private static async Task<AbsorbResult> Run(
        IPluginAdapter adapter, string origin, string modFolder, IReadOnlyList<RegisteredCopy> plugins, LoadOrderSnapshot loadOrder)
    {
        // The classifier's own rule, recomputed from git: a plugin whose baseline landed on an earlier
        // answer matches its parked ref, so answering again commits only what is left.
        if (ExternalChangeClassifier.PluginBytesIn(loadOrder, modFolder) is not { } observed)
            return AbsorbResult.Refused($"A plugin in {origin} could not be read.");
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
                return AbsorbResult.Refused(
                    $"{plugin.Name} could not be parsed from its own binary: {PluginDiagnosis.FromParseException(ex).Describe()}");
            }
        }

        var trackedFileChanges = SourceRepository.ChangedTrackedFilesOutsideSource(modFolder);

        try
        {
            // The question stays open: the next classification finds exactly what did not land.
            if (SourceRepository.CommitPristineToMain(modFolder, baselines, trackedFileChanges) is { } failed)
                return AbsorbResult.Refused($"'{failed.Subject}' {failed.Reason}. Nothing after it was committed.");
        }
        catch (GitUnavailableException ex)
        {
            return AbsorbResult.Refused(ex.Message);
        }

        // Index matches the working tree for every changed tracked file, so the same bytes cannot
        // re-raise the question next load.
        SourceRepository.StageTrackedFileChanges(modFolder, trackedFileChanges);

        // The question this exit path answers is answered: every plugin the mod holds is unblocked
        // again.
        SourceRepository.ClearExternalChangeQuestion(modFolder);
        return AbsorbResult.Success();
    }
}
