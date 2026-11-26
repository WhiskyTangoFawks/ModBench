using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class IndexFileLocationTests
{
    [Fact]
    public void TheIndexFile_LivesInTheInstanceRoot_BesideTheModManagersContent_AndTheSameInstanceSpeltDifferentlyFindsIt()
    {
        using var fixture = new PluginFixtureBuilder("index-file").WithPlugin("A.esp").Build();
        var instance = Directory.CreateDirectory(Path.Combine(fixture.InstanceRoot, "instance")).FullName;
        Directory.CreateDirectory(Path.Combine(instance, "mods"));
        var spelledOtherwise = Path.Combine(instance, "mods", "..") + Path.DirectorySeparatorChar;
        using (Indexes.Reconciled(fixture, instance)) { }

        using var opens = new GatedPluginAdapter();
        using var warm = Indexes.Reconciled(fixture, spelledOtherwise, opens);

        Assert.Equal(0, opens.OpenedTotal);
        Assert.Equal(Path.Combine(instance, "modbench", "index.duckdb"), IndexFiles.In(instance));
    }
}
