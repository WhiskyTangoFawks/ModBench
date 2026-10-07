using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.Records;

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
        var key = new PluginAddress(entry.Name, entry.Origin);
        using var index = Indexes.Reconciled(fixture);
        using var mod = Fallout4Mod.CreateFromBinaryOverlay(entry.Path, Fallout4Release.Fallout4);

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var all = index.RequireReads().DocumentsOf(key);
        var headerTheCodecCannotProduceBecauseAModHeaderIsNotAMajorRecord = Assert.Single(all, d => d.RecordType == PluginHeader.RecordType);
        Assert.NotNull(headerTheCodecCannotProduceBecauseAModHeaderIsNotAMajorRecord.Body);
        var stored = all.Where(d => d != headerTheCodecCannotProduceBecauseAModHeaderIsNotAMajorRecord).ToDictionary(
            d => d.FormKey,
            d => d.Body ?? throw new InvalidOperationException($"Expected document '{d.FormKey}' to carry a body."));
        var expected = mod.EnumerateMajorRecords().ToDictionary(
            record => record.FormKey.ToString(),
            record => Encoding.UTF8.GetString(codec.SerializeToBytes(record, GameRelease.Fallout4)));

        Assert.Equal(expected.Keys.Order(StringComparer.Ordinal), stored.Keys.Order(StringComparer.Ordinal));
        var recordsWhoseStoredBodyDiffers = expected.Where(record => stored[record.Key] != record.Value).Select(record => record.Key).ToList();
        Assert.Empty(recordsWhoseStoredBodyDiffers);
    }
}
