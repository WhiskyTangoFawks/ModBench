using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
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
        using var index = Indexes.Reconciled(fixture, fixture.InstanceRoot);
        using var mod = Fallout4Mod.CreateFromBinaryOverlay(entry.Path, Fallout4Release.Fallout4);

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var stored = IndexFiles.Rows(fixture.InstanceRoot, $"SELECT form_key, body FROM records WHERE record_type <> '{PluginHeader.RecordType}'")
            .ToDictionary(row => row[0], row => row[1]);
        var expected = mod.EnumerateMajorRecords().ToDictionary(
            record => record.FormKey.ToString(),
            record => codec.SerializeToText(record, GameRelease.Fallout4));

        Assert.Equal(expected.Keys.Order(StringComparer.Ordinal), stored.Keys.Order(StringComparer.Ordinal));
        var recordsWhoseStoredBodyDiffers = expected.Where(record => stored[record.Key] != record.Value).Select(record => record.Key).ToList();
        Assert.Empty(recordsWhoseStoredBodyDiffers);
    }
}
