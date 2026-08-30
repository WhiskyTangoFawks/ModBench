using System.Security.Cryptography;
using MEditService.Core.Plugins;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Source;

/// <summary>
/// #417's "Absorb Upstream Update" exit path, end to end: deep-parses the externally-changed binary
/// now sitting at <paramref name="pluginPath"/> — the same technique <see cref="TrackService"/> uses
/// at Track time, because this is exactly that operation again (a fresh baseline serialized from a
/// binary) for a different trigger — then commits the result onto <c>main</c> as a new baseline via
/// <see cref="SourceRepository.CommitPristineToMain"/> (no checkout, the edit branch untouched).
///
/// <para>No per-record diffing here, deliberately: unlike Keep as My Edit
/// (<see cref="ExternalChangeEditLander"/>), Absorb re-serializes the whole plugin wholesale, exactly
/// as Track does — the per-record reconciliation against the edit branch's own changes is git's own
/// job, done by the rebase this exit path offers next (<see cref="SourceRepository.RebaseEditBranch"/>),
/// not by this method.</para>
///
/// <para><b>"Exactly as Track does" is now literally true (#454), and it was not before.</b> This used
/// to build the tree one record at a time through <c>SourceRecordPath.For</c> — a second, divergent
/// implementation of the door's write, which since #451 produced a tree missing the one non-record
/// file: the root <c>RecordData.json</c> (the mod header's own source file).
/// <see cref="SourceRepository.CommitPristineToMain"/> writes only what it is handed and
/// never merges with the previous tree, so that was <i>deleted</i> from the baseline, leaving a tree
/// nothing could read back — compile and ingest-from-source both take ModKey and GameRelease from that
/// root document. It now shares <see cref="TrackService.SerializeToPristineFiles"/>, so there is one
/// implementation and it cannot drift again. Absorb's old container refusal went with it: it existed
/// because the per-record path had no flat path for a Cell/Worldspace/Quest, and the whole-mod door
/// has no such limitation, so the refusal had no subject left (#460, Absorb half).</para>
/// </summary>
public static class ExternalChangeAbsorber
{
    public static void Absorb(string modFolder, string pluginName, string pluginPath, ILoadOrder loadOrder)
    {
        // A fresh deep parse of the binary now on disk — not any cached/load order view of the plugin,
        // which is exactly the state this method exists to react to (the binary changed out from
        // under whatever a load order last read). #515: explicit strings parameters, same reason
        // TrackService's own deep parse needs them — this path always has a mod folder (Absorb only
        // ever runs against an already-tracked plugin), so LocalizedStrings.ForRead's single-argument
        // overload applies.
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

        // The question this exit path answers is answered — a same-plugin edit refused for this
        // reason is unblocked again, and the next detection starts clean.
        ExternalChangeDeferral.Clear(modFolder, pluginName);
    }
}
