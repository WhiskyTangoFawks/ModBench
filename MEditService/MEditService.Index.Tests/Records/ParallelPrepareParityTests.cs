using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

// Ingest prepares records in parallel and appends sequentially, so the stored document must be the
// codec's own sequential output byte for byte: the committed form of the byte-identical check the
// parallel path leans on.
public class ParallelPrepareParityTests
{
    [Fact]
    public void IndexedDocuments_AreByteIdenticalToSequentialCodecOutput()
    {
        using var fixture = new PluginFixtureBuilder("parity")
            .WithPlugin("Parity.esp", mod =>
            {
                var race = mod.Races.AddNew("ParityRace");
                for (var i = 0; i < 300; i++)
                {
                    var npc = mod.Npcs.AddNew($"ParityNpc{i:D3}");
                    npc.Race.SetTo(race.FormKey);
                }
                for (var i = 0; i < 300; i++) mod.Keywords.AddNew($"ParityKeyword{i:D3}");
            }, origin: "ModA")
            .BuildScattered();
        var entry = fixture.Plugins.Single();
        var key = new PluginCopyKey(entry.Name, entry.Origin);
        using var index = Indexes.Reconciled(fixture);
        using var mod = Fallout4Mod.CreateFromBinaryOverlay(entry.Path, Fallout4Release.Fallout4);

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var all = index.RequireReads().GetDocuments(key);
        // The plugin header is a document this codec cannot produce: a ModHeader is not an
        // IMajorRecordGetter, so it is neither enumerated nor reachable through SerializeToBytes.
        // Counted rather than filtered silently, so "one per record, plus the header" stays an assertion.
        var header = Assert.Single(all, d => d.RecordType == PluginHeader.RecordType);
        Assert.NotNull(header.Body);
        var stored = all.Where(d => d != header).ToDictionary(
            d => d.FormKey,
            d => d.Body ?? throw new InvalidOperationException($"Expected document '{d.FormKey}' to carry a body."));
        var records = mod.EnumerateMajorRecords().ToList();

        Assert.Equal(records.Count, stored.Count);
        foreach (IMajorRecordGetter record in records)
        {
            var expected = Encoding.UTF8.GetString(codec.SerializeToBytes(record, GameRelease.Fallout4));
            Assert.Equal(expected, stored[record.FormKey.ToString()]);
        }
    }
}
