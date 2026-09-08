using System.Security.Cryptography;
using MEditService.Core.Plugins;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Source;

/// <summary>The "Absorb Upstream Update" exit path: re-serializes the whole plugin as Track does and
/// commits it to main as a new baseline. No per-record diffing — reconciling against the edit
/// branch is the rebase's job.</summary>
public static class ExternalChangeAbsorber
{
    public static AbsorbResult Absorb(string modFolder, string pluginName, string pluginPath, LoadOrder loadOrder)
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
        return AbsorbResult.Success();
    }
}

/// <summary>Absorb Upstream Update's outcome — the applied-or-refusal spine its Keep sibling returns
/// (ADR-0046 invariant 8), so a binary that cannot be parsed is an answer, not an exception.</summary>
public sealed record AbsorbResult(bool Applied, string? RefusalReason)
{
    public static AbsorbResult Success() => new(true, null);

    public static AbsorbResult Refused(string reason) => new(false, reason);
}
