using System.Security.Cryptography;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Commands;

/// <summary>Absorb's handler: re-serializes every plugin of the mod as Track does,
/// commits the mod's whole tracked-file change to main as a new baseline, then rebases the edit
/// branch onto it at once.</summary>
public sealed class AbsorbExternalChangeHandler
{
    private readonly ILogger<AbsorbExternalChangeHandler> _logger;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal AbsorbExternalChangeHandler(ILogger<AbsorbExternalChangeHandler> logger) => _logger = logger;

    public AbsorbResult Absorb(string modFolder, IReadOnlyList<RegisteredCopy> plugins, LoadOrder loadOrder)
    {
        var result = Run(modFolder, plugins, loadOrder);
        // Track's own endpoint already logs its refusal, so Absorb gains the same posture.
        if (!result.Applied)
            _logger.LogWarning("Refused to absorb {ModFolder}: {Reason}", modFolder, result.RefusalReason);
        else if (result.Rebase is { Outcome: not RebaseOutcome.Clean } rebase)
            _logger.LogWarning("Absorbed {ModFolder}; its rebase {Outcome}: {Reason}", modFolder, rebase.Outcome, rebase.RefusalReason);
        return result;
    }

    // Static because none of it reads this handler's state.
    private static AbsorbResult Run(string modFolder, IReadOnlyList<RegisteredCopy> plugins, LoadOrder loadOrder)
    {
        var allPristineFiles = new List<PristineFile>();
        var binarySha256ByPlugin = new Dictionary<string, string>();

        foreach (var plugin in plugins)
        {
            // A fresh deep parse of the binary now on disk, never a cached load-order view — that stale
            // view is what this method reacts to. Absorb only runs against a tracked plugin, so the
            // mod-folder-only ForRead overload applies.
            IMod deepParsed;
            try
            {
                deepParsed = MutagenPluginAdapter.Instance.OpenForWrite(
                    new ModPath(ModKey.FromFileName(plugin.Name), plugin.Path), loadOrder.GameRelease,
                    PluginStrings.In(modFolder));
            }
            catch (Exception ex)
            {
                // A raw parse exception's Message carries no located identity; the diagnosis walks the
                // tree for the innermost RecordException, as Track's own parse refusal does.
                return AbsorbResult.Refused(
                    $"{plugin.Name} could not be parsed from its own binary: {PluginDiagnosis.FromParseException(ex).Describe()}");
            }

            allPristineFiles.AddRange(
                PluginTrees.SerializeToPristineFiles(deepParsed, plugin.Name).GetAwaiter().GetResult());
            binarySha256ByPlugin[plugin.Name] = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(plugin.Path)));
        }

        var trackedFileChanges = SourceRepository.ChangedTrackedFilesOutsideSource(modFolder);
        var trailers = new TrackProvenance(MetaIni.ReadVersion(modFolder), MetaIni.ComputeSha256(modFolder), binarySha256ByPlugin);

        try
        {
            SourceRepository.CommitPristineToMain(modFolder, allPristineFiles, trailers, trackedFileChanges);
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
        ExternalChangeDeferral.Clear(modFolder);
        // A refused or conflicted rebase still leaves this Absorb applied: main already moved.
        return AbsorbResult.Success(SourceRepository.RebaseEditBranch(modFolder));
    }
}
