using System.Security.Cryptography;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
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
/// </summary>
public static class ExternalChangeAbsorber
{
    public static void Absorb(string modFolder, string pluginName, string pluginPath, GameRelease gameRelease, ISchemaReflector reflector)
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var schemas = reflector.GetSchemas(gameRelease);

        // A fresh deep parse of the binary now on disk — not any cached/session view of the plugin,
        // which is exactly the state this method exists to react to (the binary changed out from
        // under whatever a session last read).
        var deepParsed = ModFactory.ImportSetter(new ModPath(ModKey.FromFileName(pluginName), pluginPath), gameRelease);
        var allRecords = deepParsed.EnumerateMajorRecords().ToList();

        // #451 review: unlike SourceFreshness (a read, degrades) or RecordEditService (a point write,
        // refuses one record), Absorb rebuilds the *whole* pristine tree from this list — a container
        // record silently skipped here would not just go unhandled, it would vanish from the new
        // baseline commit entirely (CommitPristineToMain below writes only what pristineFiles holds,
        // no merge with the previous tree). So this checks and refuses the whole operation up front,
        // before anything is written, rather than partially completing over real data loss. Point-write
        // support for containers is #453's; this class stays a whole-plugin re-serialize either way.
        var containerRecords = allRecords
            .Where(r => RecordTypeDispatch.For(gameRelease).FolderNameFor(SourceRecordType.Resolve(r, schemas)) is null)
            .Select(r => $"{r.FormKey} ({r.GetType().Name})")
            .ToList();
        if (containerRecords.Count > 0)
        {
            throw new ContainerRecordsNotYetSupportedException(
                $"{pluginName} holds container record(s) — {string.Join(", ", containerRecords)} — that Absorb Upstream " +
                "Update cannot yet re-serialize (#453). Nothing was written.");
        }

        var pristineFiles = new List<PristineFile>();
        foreach (var record in allRecords)
        {
            var recordType = SourceRecordType.Resolve(record, schemas);
            var relativePath = SourceRecordPath.For(pluginName, recordType, record.FormKey.ToString(), record.EditorID, gameRelease);
            var bytes = codec.SerializeToBytesAsync(record, gameRelease).GetAwaiter().GetResult();
            pristineFiles.Add(new PristineFile(relativePath, bytes));
        }

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

/// <summary>Thrown by <see cref="ExternalChangeAbsorber.Absorb"/> when the plugin holds a container
/// record (Cell/Worldspace/Quest) — named and actionable (never a bare <see cref="NotSupportedException"/>
/// a caller would have to string-match) so the endpoint layer maps it to a real, explained failure
/// rather than an unhandled 500 (#451 review).</summary>
public sealed class ContainerRecordsNotYetSupportedException : Exception
{
    public ContainerRecordsNotYetSupportedException() : base("This plugin holds container records Absorb cannot yet re-serialize.")
    {
    }

    public ContainerRecordsNotYetSupportedException(string message) : base(message)
    {
    }

    public ContainerRecordsNotYetSupportedException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
