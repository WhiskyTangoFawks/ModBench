using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public class PluginDocumentsTests
{
    [Fact]
    public void DocumentsOf_ReturnsEveryDocumentThePluginIndexed()
    {
        using var fixture = new PluginFixtureBuilder("bulk-read")
            .WithPlugin("Bulk.esp", mod =>
            {
                var race = mod.Races.AddNew("BulkRace");
                var npc = mod.Npcs.AddNew("BulkNpc");
                npc.Race.SetTo(race.FormKey);
                var broken = mod.Npcs.AddNew("BrokenNpc");
                broken.Race.SetTo(new FormKey(ModKey.FromFileName("Missing.esp"), 0x000801));
            }, origin: "ModA")
            .BuildScattered();
        var entry = fixture.Plugins.Single();
        var key = new PluginAddress(entry.Name, entry.Origin);
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();
        using var onDisk = Fallout4Mod.CreateFromBinaryOverlay(entry.Path, Fallout4Release.Fallout4);

        var documents = reads.DocumentsOf(key);

        var majorRecordCountExcludingTheHeaderBecauseEnumerateMajorRecordsCannotCountIt = onDisk.EnumerateMajorRecords().Count();
        Assert.Equal(majorRecordCountExcludingTheHeaderBecauseEnumerateMajorRecordsCannotCountIt + 1, documents.Count);
        Assert.Single(documents, d => d.RecordType == PluginHeader.RecordType);
        string? RaceFieldErrorAloneBecauseABareNpcFlagsOtherUnsetLinks(string editorId) => documents
            .Single(d => d.EditorId == editorId).Fields
            .Single(f => f.Metadata.Name.Equals("Race", StringComparison.OrdinalIgnoreCase))
            .CheckError;
        Assert.Null(RaceFieldErrorAloneBecauseABareNpcFlagsOtherUnsetLinks("BulkNpc"));
        Assert.Contains("Could not be resolved", RaceFieldErrorAloneBecauseABareNpcFlagsOtherUnsetLinks("BrokenNpc"));
    }

    [Fact]
    public void DocumentsOf_TwoOriginsSameFilename_ScopesToRequestedOrigin()
    {
        using var fixture = new PluginFixtureBuilder("bulk-read-origins")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .WithPlugin("Shared.esp", mod =>
            {
                mod.Npcs.AddNew("FromModB");
                mod.Npcs.AddNew("SecondFromModB");
            }, origin: "ModB")
            .BuildScattered();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        IReadOnlyList<RecordDocument> DocumentsWhileWinning(string origin) =>
            index.ReadsWithWinner(holder, fixture.GameDirectory, fixture.Plugins, origin)
                .DocumentsOf(new PluginAddress("Shared.esp", origin));

        var fromA = DocumentsWhileWinning("ModA");
        Assert.Empty(index.RequireReads().DocumentsOf(new PluginAddress("Shared.esp", "ModB")));
        var fromB = DocumentsWhileWinning("ModB");
        var recordsFromA = fromA.Where(d => d.RecordType != PluginHeader.RecordType).ToList();
        var recordsFromB = fromB.Where(d => d.RecordType != PluginHeader.RecordType).ToList();

        var single = Assert.Single(recordsFromA);
        Assert.Equal("FromModA", single.EditorId);
        Assert.Equal("ModA", single.Plugin.Origin);
        Assert.Equal(2, recordsFromB.Count);
        Assert.All(recordsFromB, d => Assert.Equal("ModB", d.Plugin.Origin));

        Assert.Equal("ModA", Assert.Single(fromA, d => d.RecordType == PluginHeader.RecordType).Plugin.Origin);
        Assert.Equal("ModB", Assert.Single(fromB, d => d.RecordType == PluginHeader.RecordType).Plugin.Origin);
    }
}
