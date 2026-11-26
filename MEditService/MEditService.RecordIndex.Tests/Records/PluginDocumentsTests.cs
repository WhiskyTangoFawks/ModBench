using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public class PluginDocumentsTests
{
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
            index.WithWinner(holder, fixture.DataFolder, fixture.Plugins, origin);
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
