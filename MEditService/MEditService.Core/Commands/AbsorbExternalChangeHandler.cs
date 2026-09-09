using System.Security.Cryptography;
using MEditService.Core.Plugins;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Commands;

/// <summary>Absorb Upstream Update's handler: re-serializes the plugin as Track does, commits it to
/// main as a new baseline, then rebases the edit branch onto it at once.</summary>
public sealed class AbsorbExternalChangeHandler
{
    private readonly ILogger<AbsorbExternalChangeHandler> _logger;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal AbsorbExternalChangeHandler(ILogger<AbsorbExternalChangeHandler> logger) => _logger = logger;

    public AbsorbResult Absorb(string modFolder, string pluginName, string pluginPath, LoadOrder loadOrder)
    {
        var result = Run(modFolder, pluginName, pluginPath, loadOrder);
        // Track's own endpoint already logs its refusal, so Absorb gains the same posture.
        if (!result.Applied)
            _logger.LogWarning("Refused to absorb {Plugin}: {Reason}", pluginName, result.RefusalReason);
        else if (result.Rebase is { Outcome: not RebaseOutcome.Clean } rebase)
            _logger.LogWarning("Absorbed {Plugin}; its rebase {Outcome}: {Reason}", pluginName, rebase.Outcome, rebase.RefusalReason);
        return result;
    }

    // Static because none of it reads this handler's state.
    private static AbsorbResult Run(string modFolder, string pluginName, string pluginPath, LoadOrder loadOrder)
    {
        // A fresh deep parse of the binary now on disk, never a cached load-order view — that stale view
        // is what this method reacts to. Absorb only runs against a tracked plugin, so the mod-folder-only
        // ForRead overload applies.
        IMod deepParsed;
        try
        {
            deepParsed = ModFactory.ImportSetter(
                new ModPath(ModKey.FromFileName(pluginName), pluginPath), loadOrder.GameRelease,
                LocalizedStrings.ForRead(modFolder));
        }
        catch (Exception ex)
        {
            // A raw parse exception's Message carries no located identity; the diagnosis walks the tree
            // for the innermost RecordException, as Track's own parse refusal does.
            return AbsorbResult.Refused(
                $"{pluginName} could not be parsed from its own binary: {PluginDiagnosis.FromParseException(ex).Describe()}");
        }

        var pristineFiles = TrackService
            .SerializeToPristineFiles(deepParsed, pluginName)
            .GetAwaiter().GetResult();

        var binarySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(pluginPath)));
        var trailers = new TrackProvenance(
            MetaIni.ReadVersion(modFolder),
            MetaIni.ComputeSha256(modFolder),
            new Dictionary<string, string> { [pluginName] = binarySha256 });

        try
        {
            SourceRepository.CommitPristineToMain(modFolder, pristineFiles, trailers);
        }
        catch (GitUnavailableException ex)
        {
            return AbsorbResult.Refused(ex.Message);
        }

        // The question this exit path answers is answered: same-plugin edits are unblocked again.
        ExternalChangeDeferral.Clear(modFolder, pluginName);
        // A refused or conflicted rebase still leaves this Absorb applied: main already moved.
        return AbsorbResult.Success(SourceRepository.RebaseEditBranch(modFolder));
    }
}
