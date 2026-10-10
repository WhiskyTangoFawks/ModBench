using MEditService.Codec.Schema;
using MEditService.Index.Queries;
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
    public void APluginsDocuments_AreEveryDocumentItIndexed()
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
        using var onDisk = Fallout4Mod.CreateFromBinaryOverlay(entry.Path, Fallout4Release.Fallout4);

        var listed = index.ListedIn(key);

        Assert.Equal(onDisk.EnumerateMajorRecords().Count(), listed.Count);
        Assert.NotNull(index.CopyIn(PluginHeader.FormKeyFor(ModKey.FromFileName(entry.Name)), key));
        string? RaceFieldErrorAloneBecauseABareNpcFlagsOtherUnsetLinks(string editorId) => index
            .DocumentOf(listed.Single(d => d.EditorId == editorId).FormKey, key).Fields
            .Single(f => f.Metadata.Name.Equals("Race", StringComparison.OrdinalIgnoreCase))
            .CheckError;
        Assert.Null(RaceFieldErrorAloneBecauseABareNpcFlagsOtherUnsetLinks("BulkNpc"));
        Assert.Contains("Could not be resolved", RaceFieldErrorAloneBecauseABareNpcFlagsOtherUnsetLinks("BrokenNpc"));
    }

    [Fact]
    public void APluginsDocuments_OfTwoOriginsOfOneFilename_AreScopedToTheOrigin()
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
        var header = PluginHeader.FormKeyFor(ModKey.FromFileName("Shared.esp"));
        (IReadOnlyList<RecordSummary> Records, string HeaderOrigin) ListedWhileWinning(string origin)
        {
            var plugin = new PluginAddress("Shared.esp", origin);
            index.WithWinner(holder, fixture.GameDirectory, fixture.Plugins, origin);
            return (index.ListedIn(plugin), index.DocumentOf(header, plugin).Origin);
        }

        var fromA = ListedWhileWinning("ModA");
        Assert.Empty(index.ListedIn(new PluginAddress("Shared.esp", "ModB")));
        var fromB = ListedWhileWinning("ModB");

        var single = Assert.Single(fromA.Records);
        Assert.Equal("FromModA", single.EditorId);
        Assert.Equal("ModA", single.Origin);
        Assert.Equal(2, fromB.Records.Count);
        Assert.All(fromB.Records, d => Assert.Equal("ModB", d.Origin));

        Assert.Equal("ModA", fromA.HeaderOrigin);
        Assert.Equal("ModB", fromB.HeaderOrigin);
    }
}
