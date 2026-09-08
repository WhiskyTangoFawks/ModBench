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
    public static void Absorb(string modFolder, string pluginName, string pluginPath, LoadOrder loadOrder)
    {
        // A fresh deep parse of the binary now on disk, never a cached load-order view — that stale view
        // is what this method reacts to. Absorb only runs against a tracked plugin, so the mod-folder-only
        // ForRead overload applies.
        var deepParsed = ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(pluginName), pluginPath), loadOrder.GameRelease,
            LocalizedStrings.ForRead(modFolder));

        var pristineFiles = TrackService
            .SerializeToPristineFiles(deepParsed, pluginName)
            .GetAwaiter().GetResult();

        var binarySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(pluginPath)));
        var trailers = new TrackProvenance(
            MetaIni.ReadVersion(modFolder),
            MetaIni.ComputeSha256(modFolder),
            new Dictionary<string, string> { [pluginName] = binarySha256 });

        SourceRepository.CommitPristineToMain(modFolder, pristineFiles, trailers);

        // The question this exit path answers is answered: same-plugin edits are unblocked again.
        ExternalChangeDeferral.Clear(modFolder, pluginName);
    }
}
