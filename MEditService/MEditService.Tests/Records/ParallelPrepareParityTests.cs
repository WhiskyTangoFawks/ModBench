using System.Text;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

// Index() prepares records in parallel (serialize, hash, refs) and appends sequentially. The
// document the index stores for a record must be the codec's own sequential output, byte for
// byte — this is the committed form of the "verified byte-identical" check the parallel path
// leans on, so a future change to the parallel section cannot silently drift from the codec.
public class ParallelPrepareParityTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;

    [Fact]
    public async Task IndexedDocuments_AreByteIdenticalToSequentialCodecOutput()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Parity.esp"), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("ParityRace");
        for (var i = 0; i < 300; i++)
        {
            var npc = mod.Npcs.AddNew($"ParityNpc{i:D3}");
            npc.Race.SetTo(race.FormKey);
        }
        for (var i = 0; i < 300; i++) mod.Keywords.AddNew($"ParityKeyword{i:D3}");

        using var repo = new DuckDbRecordIndex(Reflector, new TableDdlBuilder(Reflector), NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var key = new PluginKey("Parity.esp", "ModA");
        repo.Index(mod, Registration.Participating(0), key);

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var all = repo.At(RecordRef.Effective).GetDocuments(key);
        // The plugin header is a document too since #631, but not one this codec can produce: a
        // ModHeader is not an IMajorRecordGetter, so it is neither in EnumerateMajorRecords below nor
        // reachable through SerializeToBytesAsync. Split out and counted rather than filtered
        // silently, so "one document per record, plus the header" stays an assertion.
        var header = Assert.Single(all, d => d.RecordType == HeaderIndexer.RecordType);
        Assert.NotNull(header.Body);
        var stored = all.Where(d => d != header).ToDictionary(d => d.FormKey, d => d.Body!);
        var records = mod.EnumerateMajorRecords().ToList();

        Assert.Equal(records.Count, stored.Count);
        foreach (IMajorRecordGetter record in records)
        {
            var expected = Encoding.UTF8.GetString(await codec.SerializeToBytesAsync(record, GameRelease.Fallout4));
            Assert.Equal(expected, stored[record.FormKey.ToString()]);
        }
    }
}
