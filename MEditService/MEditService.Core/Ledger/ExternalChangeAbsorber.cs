using System.Security.Cryptography;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Ledger;

/// <summary>
/// #417's "Absorb Upstream Update" exit path, end to end: deep-parses the externally-changed binary
/// now sitting at <paramref name="pluginPath"/> — the same technique <see cref="TrackService"/> uses
/// at Track time, because this is exactly that operation again (a fresh baseline serialized from a
/// binary) for a different trigger — then commits the result onto <c>main</c> as a new baseline via
/// <see cref="LedgerRepository.CommitPristineToMain"/> (no checkout, the edit branch untouched).
///
/// <para>No per-record diffing here, deliberately: unlike Keep as My Edit
/// (<see cref="ExternalChangeEditLander"/>), Absorb re-serializes the whole plugin wholesale, exactly
/// as Track does — the per-record reconciliation against the edit branch's own changes is git's own
/// job, done by the rebase this exit path offers next (<see cref="LedgerRepository.RebaseEditBranch"/>),
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
        var pristineFiles = new List<PristineFile>();
        foreach (var record in deepParsed.EnumerateMajorRecords())
        {
            ContainerStripFields.StripInPlace(record);
            var recordType = LedgerRecordType.Resolve(record, schemas);
            var relativePath = LedgerRecordPath.For(pluginName, recordType, record.FormKey.ToString());
            var bytes = codec.SerializeToBytesAsync(record, gameRelease).GetAwaiter().GetResult();
            pristineFiles.Add(new PristineFile(relativePath, bytes));
        }

        var binarySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(pluginPath)));
        var trailers = new TrackProvenance(
            MetaIni.ReadVersion(modFolder),
            MetaIni.ComputeSha256(modFolder),
            new Dictionary<string, string> { [pluginName] = binarySha256 });

        LedgerRepository.CommitPristineToMain(modFolder, pristineFiles, trailers);

        // The question this exit path answers is answered — a same-plugin edit refused for this
        // reason is unblocked again, and the next detection starts clean.
        ExternalChangeDeferral.Clear(modFolder, pluginName);
    }
}
