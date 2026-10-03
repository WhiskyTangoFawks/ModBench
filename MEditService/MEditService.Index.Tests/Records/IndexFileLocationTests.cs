using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.Records;

public sealed class IndexFileLocationTests : IDisposable
{
    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("index-file").WithPlugin("A.esp").Build();

    public void Dispose() => _fixture.Dispose();

    private string Instance(string name) => Directory.CreateDirectory(Path.Combine(_fixture.InstanceRoot, name)).FullName;

    [Fact]
    public void TheIndexFile_LivesInTheInstanceRoot_BesideTheModManagersContent_NeverInsideIt()
    {
        var instance = Instance("instance");
        foreach (var managed in new[] { "mods", "overwrite", "profiles", "downloads" })
            Directory.CreateDirectory(Path.Combine(instance, managed));

        using (var index = Indexes.Reconciled(_fixture, instance)) { }

        Assert.Equal(Path.Combine(instance, "modbench", "index.duckdb"), IndexFiles.In(instance));
    }

    [Fact]
    public void TheSameInstanceSpeltDifferently_FindsTheOneFile()
    {
        var instance = Instance("instance-spelling");
        Directory.CreateDirectory(Path.Combine(instance, "mods"));
        var spelledOtherwise = Path.Combine(instance, "mods", "..") + Path.DirectorySeparatorChar;
        using (var cold = Indexes.Reconciled(_fixture, instance)) { }

        using var opens = new GatedPluginAdapter();
        using var warm = Indexes.Reconciled(_fixture, spelledOtherwise, opens);

        Assert.Equal(0, opens.OpenedTotal);
        Assert.Single(Directory.GetFiles(instance, "*.duckdb", SearchOption.AllDirectories));
    }

    [Fact]
    public void ADifferentInstance_GetsItsOwnFile()
    {
        var a = Instance("instance-a");
        var b = Instance("instance-b");

        using (var first = Indexes.Reconciled(_fixture, a)) { }
        using (var second = Indexes.Reconciled(_fixture, b)) { }

        Assert.NotEqual(IndexFiles.In(a), IndexFiles.In(b));
    }
}
